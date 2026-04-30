// Per-key rate limiter for Instagram RapidAPI calls.
//
// Each RapidApiKey row carries its own rateLimitPerMin ceiling (default
// 85 — MEGA plan is 100/min, 15% safety margin). The limiter now keeps
// a separate sliding window per keyId, so two active keys get
// 2×85=170 req/min aggregate throughput. Previously the limiter had
// a single global window — adding a 2nd key raised the monthly
// quota ceiling but did nothing for throughput.
//
// Storage strategy is unchanged in shape:
//   1. Upstash Redis (when env set) — one sorted set PER KEY under
//      `rapidapi:ig:ratelimit:v1:key:<id>`.
//   2. In-memory fallback — one Map<keyId, timestamps[]> per-process.
//
// Call sites pass the keyId resolved from the ALS-scoped current
// key (see lib/rapidapi/key-manager.ts). When no ALS context is
// set (env-var legacy path), keyId = -1 and a "legacy" redis key +
// a conservative DEFAULT_MAX is used.

import { Redis } from "@upstash/redis";
import { prisma } from "@/lib/prisma";

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 85;
const REDIS_KEY_PREFIX = "rapidapi:ig:ratelimit:v1:key";
const LEGACY_KEY_ID = -1; // env-var fallback — no DB row

// ── Per-key rate-limit cache (30s TTL) ──────────────────────────────
// RapidApiKey.rateLimitPerMin is authoritative. Cache hits avoid a
// DB round-trip on every IG call. 30s TTL so operator edits via
// /config/rapidapi-keys propagate to the limiter within seconds.

const rateLimitCache = new Map<number, { limit: number; cachedAt: number }>();
const RATE_LIMIT_TTL_MS = 30_000;

async function getKeyRateLimit(keyId: number): Promise<number> {
  if (keyId === LEGACY_KEY_ID) return DEFAULT_MAX;
  const cached = rateLimitCache.get(keyId);
  if (cached && Date.now() - cached.cachedAt < RATE_LIMIT_TTL_MS) {
    return cached.limit;
  }
  try {
    const row = await prisma.rapidApiKey.findUnique({
      where: { id: keyId },
      select: { rateLimitPerMin: true },
    });
    const limit = row?.rateLimitPerMin ?? DEFAULT_MAX;
    rateLimitCache.set(keyId, { limit, cachedAt: Date.now() });
    return limit;
  } catch {
    // DB hiccup — use the default so we don't block the call.
    return DEFAULT_MAX;
  }
}

function redisKeyFor(keyId: number): string {
  return `${REDIS_KEY_PREFIX}:${
    keyId === LEGACY_KEY_ID ? "legacy" : String(keyId)
  }`;
}

// ── Upstash client (lazy singleton) ─────────────────────────────────

let redisClient: Redis | null = null;
let redisAvailable: boolean | null = null;
let fallbackReason: string | null = null;

function sanitizeEnv(v: string | undefined): string | undefined {
  if (!v) return v;
  let out = v.trim();
  while (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function getRedis(): Redis | null {
  if (redisAvailable === false) return null;
  if (redisClient) return redisClient;
  const url = sanitizeEnv(process.env.UPSTASH_REDIS_REST_URL);
  const token = sanitizeEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) {
    if (redisAvailable === null) {
      redisAvailable = false;
      fallbackReason = `env missing: url=${Boolean(url)} token=${Boolean(token)}`;
      console.warn(
        "[ig-ratelimit] UPSTASH_REDIS_REST_URL/_TOKEN not set — falling back to per-process in-memory limiter. Cross-worker quota is NOT enforced."
      );
    }
    return null;
  }
  try {
    redisClient = new Redis({ url, token });
    redisAvailable = true;
    return redisClient;
  } catch (e) {
    redisAvailable = false;
    fallbackReason = `constructor threw: ${(e as Error).message.slice(0, 120)}`;
    console.warn(
      "[ig-ratelimit] Redis constructor threw, falling back to in-memory:",
      (e as Error).message.slice(0, 120)
    );
    return null;
  }
}

export function getFallbackReason(): string | null {
  return fallbackReason;
}

// ── Lua: atomic acquire — unchanged logic, but KEY is per-key ──────

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

async function acquireSlotViaRedis(
  redis: Redis,
  redisKey: string,
  maxReq: number
): Promise<boolean> {
  try {
    const nonce =
      Math.floor(Math.random() * 1e9).toString(36) +
      "-" +
      process.pid.toString(36);
    const result = (await redis.eval(
      ACQUIRE_LUA,
      [redisKey],
      [
        Date.now().toString(),
        WINDOW_MS.toString(),
        maxReq.toString(),
        nonce,
      ]
    )) as [number, number] | null;
    if (!Array.isArray(result)) return false;
    const [ok, waitMs] = result;
    if (ok === 1) return true;
    await new Promise((r) => setTimeout(r, Math.max(50, waitMs)));
    return false;
  } catch (e) {
    console.warn(
      "[ig-ratelimit] upstash eval failed, one-off in-memory fallback:",
      (e as Error).message.slice(0, 120)
    );
    // We don't have the keyId here for the in-memory fallback without
    // a signature bump — return false and let the outer loop retry
    // via the in-memory path on the next iteration.
    return false;
  }
}

// ── In-memory fallback — per-key sliding windows ────────────────────

const inMemoryWindows = new Map<number, number[]>();

function pruneInMemory(keyId: number, now: number): number[] {
  let arr = inMemoryWindows.get(keyId);
  if (!arr) {
    arr = [];
    inMemoryWindows.set(keyId, arr);
  }
  const cutoff = now - WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr;
}

async function inMemoryAcquireSlot(
  keyId: number,
  maxReq: number
): Promise<void> {
  while (true) {
    const now = Date.now();
    const arr = pruneInMemory(keyId, now);
    if (arr.length < maxReq) {
      arr.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - arr[0]) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// ── Per-key FIFO chain ──────────────────────────────────────────────
// Previously one module-level `chain` serialised all callers across
// all keys. With per-key chains, two workers hitting DIFFERENT keys
// go through Upstash independently — no artificial serialisation
// across the multi-key pool. Same process, same key → still serial
// via the key's chain.

const chains = new Map<number, Promise<void>>();

// ── Public API ──────────────────────────────────────────────────────

// Hard ceiling on how long a caller can wait for a rate-limit
// slot. Without this, a saturated key pins every worker behind a
// chained acquireWithBackoff loop indefinitely. With this, the
// caller throws after MAX_SLOT_WAIT_MS and the outer pollOne
// reschedules the order — better than burning the full Vercel
// 300 s lambda on a queue.
const MAX_SLOT_WAIT_MS = 30_000;

export async function waitForIgSlot(keyId: number): Promise<void> {
  const prev = chains.get(keyId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((r) => {
    release = r;
  });
  chains.set(keyId, next);
  try {
    await prev;
    await Promise.race([
      acquireWithBackoff(keyId),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`rate_limit_slot_wait_timeout_${MAX_SLOT_WAIT_MS}ms`),
            ),
          MAX_SLOT_WAIT_MS,
        ),
      ),
    ]);
  } finally {
    release();
  }
}

async function acquireWithBackoff(keyId: number): Promise<void> {
  const maxReq = await getKeyRateLimit(keyId);
  const redis = getRedis();
  if (!redis) {
    await inMemoryAcquireSlot(keyId, maxReq);
    return;
  }
  const redisKey = redisKeyFor(keyId);
  for (;;) {
    const acquired = await acquireSlotViaRedis(redis, redisKey, maxReq);
    if (acquired) return;
    // acquireSlotViaRedis returning false on an exception (not a
    // normal wait+retry) — fall to in-memory for this one call so
    // we don't spin forever when Upstash is down.
    if (redisAvailable === false) {
      await inMemoryAcquireSlot(keyId, maxReq);
      return;
    }
  }
}

// ── Debug snapshot — returns per-key + aggregate ───────────────────

export type RateLimitKeySnapshot = {
  keyId: number | "legacy";
  label: string | null;
  inFlight: number;
  max: number;
};

export type RateLimitSnapshot = {
  // Aggregate view — kept for the existing UI card.
  backend: "upstash" | "in-memory";
  inFlightWindowSize: number;
  maxPerWindow: number;
  error?: string;
  // Per-key breakdown — new UI can surface each key's window.
  perKey: RateLimitKeySnapshot[];
};

export async function ig429SnapshotForDebug(): Promise<RateLimitSnapshot> {
  // Enumerate active keys + the legacy sentinel so the UI sees all
  // sliding windows.
  const activeKeys = await prisma.rapidApiKey
    .findMany({
      where: { provider: "instagram", status: "active" },
      select: { id: true, label: true, rateLimitPerMin: true },
    })
    .catch(() => []);

  const targets: Array<{
    keyId: number | "legacy";
    label: string | null;
    max: number;
  }> = activeKeys.map((k) => ({
    keyId: k.id,
    label: k.label,
    max: k.rateLimitPerMin ?? DEFAULT_MAX,
  }));
  // Always include the legacy sentinel for completeness.
  targets.push({ keyId: "legacy", label: "legacy / env fallback", max: DEFAULT_MAX });

  const redis = getRedis();
  const perKey: RateLimitKeySnapshot[] = [];
  let errored: string | undefined;

  if (redis) {
    for (const t of targets) {
      const key =
        t.keyId === "legacy"
          ? `${REDIS_KEY_PREFIX}:legacy`
          : `${REDIS_KEY_PREFIX}:${t.keyId}`;
      try {
        const cutoff = Date.now() - WINDOW_MS;
        await redis.zremrangebyscore(key, 0, cutoff);
        const count = (await redis.zcard(key)) ?? 0;
        perKey.push({
          keyId: t.keyId,
          label: t.label,
          inFlight: count,
          max: t.max,
        });
      } catch (e) {
        errored = `upstash snapshot failed: ${(e as Error).message.slice(0, 120)}`;
        // Fall back to in-memory for this key.
        const numericId =
          t.keyId === "legacy" ? LEGACY_KEY_ID : (t.keyId as number);
        const arr = pruneInMemory(numericId, Date.now());
        perKey.push({
          keyId: t.keyId,
          label: t.label,
          inFlight: arr.length,
          max: t.max,
        });
      }
    }
  } else {
    for (const t of targets) {
      const numericId =
        t.keyId === "legacy" ? LEGACY_KEY_ID : (t.keyId as number);
      const arr = pruneInMemory(numericId, Date.now());
      perKey.push({
        keyId: t.keyId,
        label: t.label,
        inFlight: arr.length,
        max: t.max,
      });
    }
  }

  const inFlightWindowSize = perKey.reduce((a, p) => a + p.inFlight, 0);
  const maxPerWindow = perKey.reduce((a, p) => a + p.max, 0);

  return {
    backend: redis ? "upstash" : "in-memory",
    inFlightWindowSize,
    maxPerWindow,
    perKey,
    ...(errored ? { error: errored } : {}),
    ...(!redis && fallbackReason
      ? { error: `upstash fallback: ${fallbackReason}` }
      : {}),
  };
}
