// Global rate limiter for Instagram RapidAPI calls.
//
// MEGA plan ceiling: 100 req/min per key. We cap at 85 req/min (15%
// safety margin) to absorb RapidAPI edge jitter and leave room for
// manual debug curls.
//
// Storage strategy:
//   1. Upstash Redis (when UPSTASH_REDIS_REST_URL + _TOKEN are set)
//      — a cross-process sorted set keyed by a request timestamp.
//      All Vercel invocations share the same budget so 4 workers
//      running in parallel collectively stay under 85/min, not 4×85.
//   2. Fallback: the original in-memory sliding window, for local
//      dev without Redis or if Upstash briefly fails. Logs a single
//      warning per process so we know it kicked in.
//
// Public API (waitForIgSlot) is unchanged — call sites in
// instagram.ts + the debug route stay identical.

import { Redis } from "@upstash/redis";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 85;
const REDIS_KEY = "rapidapi:ig:ratelimit:v1";

// ── Upstash client (lazy singleton) ─────────────────────────────────

let redisClient: Redis | null = null;
let redisAvailable: boolean | null = null; // null = not probed yet

function getRedis(): Redis | null {
  if (redisAvailable === false) return null;
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (redisAvailable === null) {
      redisAvailable = false;
      // Warn exactly once per process so we notice the fallback but
      // don't spam logs on every call.
      console.warn(
        "[ig-ratelimit] UPSTASH_REDIS_REST_URL/_TOKEN not set — falling back to per-process in-memory limiter. Cross-worker quota is NOT enforced."
      );
    }
    return null;
  }
  redisClient = new Redis({ url, token });
  redisAvailable = true;
  return redisClient;
}

// ── Lua script: atomic acquire ──────────────────────────────────────
//
// Returns { 1, 0 }        when a slot was acquired
//         { 0, waitMs }   when the caller must wait (oldest falls out
//                         of the window in waitMs)
//
// Keeping this in a Lua eval guarantees the prune+count+add triplet
// is atomic — two Vercel functions can't both see "84 < 85" and then
// both add past the cap.
const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_req = tonumber(ARGV[3])
local nonce = ARGV[4]
local cutoff = now - window_ms

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. tostring(cutoff))

local count = redis.call('ZCARD', key)
if count < max_req then
  -- member = "<now>:<nonce>" so simultaneous acquirers at the same
  -- millisecond get distinct members (ZADD overwrites by member).
  redis.call('ZADD', key, now, tostring(now) .. ':' .. nonce)
  redis.call('PEXPIRE', key, window_ms * 2)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest_score = tonumber(oldest[2])
local wait_ms = (oldest_score + window_ms) - now + 50
if wait_ms < 50 then wait_ms = 50 end
return {0, wait_ms}
`;

async function acquireSlotViaRedis(redis: Redis): Promise<boolean> {
  try {
    // Random nonce collapses nanosecond-level collisions when many
    // callers fire in the same tick.
    const nonce =
      Math.floor(Math.random() * 1e9).toString(36) +
      "-" +
      process.pid.toString(36);
    const result = (await redis.eval(
      ACQUIRE_LUA,
      [REDIS_KEY],
      [
        Date.now().toString(),
        WINDOW_MS.toString(),
        MAX_REQUESTS_PER_WINDOW.toString(),
        nonce,
      ]
    )) as [number, number] | null;
    if (!Array.isArray(result)) return false;
    const [ok, waitMs] = result;
    if (ok === 1) return true;
    await new Promise((r) => setTimeout(r, Math.max(50, waitMs)));
    return false;
  } catch (e) {
    // Upstash hiccup — fall through to the in-memory path for this
    // caller rather than blocking forever. Rare; shouldn't spam.
    console.warn(
      "[ig-ratelimit] upstash eval failed, one-off in-memory fallback:",
      (e as Error).message.slice(0, 120)
    );
    return inMemoryAcquireSlotOnce();
  }
}

// ── In-memory fallback (per-process sliding window) ─────────────────

const windowTimestamps: number[] = [];

function pruneInMemory(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (windowTimestamps.length && windowTimestamps[0] < cutoff) {
    windowTimestamps.shift();
  }
}

// Non-awaiting variant used by the Upstash fallback path: acquires
// OR returns false so the caller sleeps briefly and retries.
function inMemoryAcquireSlotOnce(): boolean {
  const now = Date.now();
  pruneInMemory(now);
  if (windowTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
    windowTimestamps.push(now);
    return true;
  }
  return false;
}

async function inMemoryAcquireSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    pruneInMemory(now);
    if (windowTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
      windowTimestamps.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - windowTimestamps[0]) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// ── Public API ──────────────────────────────────────────────────────

// Promise chain — even with Redis atomicity we keep a local FIFO so
// parallel callers inside one process don't all hammer Upstash with
// the same eval simultaneously. Queues them through eval one at a
// time; the Lua atomicity still guards cross-process.
let chain: Promise<void> = Promise.resolve();

export async function waitForIgSlot(): Promise<void> {
  const prev = chain;
  let release: () => void = () => {};
  chain = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    await acquireWithBackoff();
  } finally {
    release();
  }
}

async function acquireWithBackoff(): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    await inMemoryAcquireSlot();
    return;
  }
  // Loop until Lua returns ok=1. Each iteration either acquires or
  // sleeps for the Lua-computed waitMs before retrying.
  for (;;) {
    const acquired = await acquireSlotViaRedis(redis);
    if (acquired) return;
  }
}

// Debug helper — returns the current window size so we can inspect
// live quota usage. If the Upstash call throws (SDK typing quirk,
// network hiccup, etc.) we degrade to the in-memory count rather
// than returning a 500 to the polling UI.
export async function ig429SnapshotForDebug(): Promise<{
  backend: "upstash" | "in-memory";
  inFlightWindowSize: number;
  maxPerWindow: number;
  error?: string;
}> {
  const redis = getRedis();
  if (redis) {
    try {
      const cutoff = Date.now() - WINDOW_MS;
      // Inclusive prune — remove anything with score ≤ cutoff. This
      // drops rows at the exact boundary (which are 60s-old to the
      // millisecond, semantically expired for our use case) and
      // avoids the SDK's typing quirks around the "(" exclusive
      // prefix string.
      await redis.zremrangebyscore(REDIS_KEY, 0, cutoff);
      const count = (await redis.zcard(REDIS_KEY)) ?? 0;
      return {
        backend: "upstash",
        inFlightWindowSize: count,
        maxPerWindow: MAX_REQUESTS_PER_WINDOW,
      };
    } catch (e) {
      // Surface the reason so the UI can show it + fall through to
      // the in-memory count for a best-effort read.
      pruneInMemory(Date.now());
      return {
        backend: "in-memory",
        inFlightWindowSize: windowTimestamps.length,
        maxPerWindow: MAX_REQUESTS_PER_WINDOW,
        error: `upstash snapshot failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
  }
  pruneInMemory(Date.now());
  return {
    backend: "in-memory",
    inFlightWindowSize: windowTimestamps.length,
    maxPerWindow: MAX_REQUESTS_PER_WINDOW,
  };
}
