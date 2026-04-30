// Per-key in-process circuit breaker for RapidAPI calls.
//
// When a key starts failing repeatedly (timeouts, 5xx, hung sockets),
// keep using it would burn the entire cron tick on dead requests.
// We track consecutive failures per keyId in a process-memory Map;
// once `tripCount` is hit, the key is "tripped" for `cooldownMs` so
// long-running jobs (poller, scraper, sweep) skip it until the
// cooldown expires.
//
// Shared across all callers — poller, scraper, sweep — so a key
// flagged degraded by one job is automatically skipped by the
// others. Per-Vercel-function-instance (in-memory), so there's no
// cross-instance coordination — that's intentional, the cooldown
// is short enough that each instance learns independently.

const TRIP_COUNT = 5;
const COOLDOWN_MS = 15 * 60_000; // 15 min
const FAILURE_LATENCY_MS = 20_000; // poll/fetch >20 s counts as a failure

type KeyState = {
  failures: number;
  trippedAt: number; // 0 when not tripped
};

const state = new Map<number, KeyState>();

function getOrInit(keyId: number): KeyState {
  let s = state.get(keyId);
  if (!s) {
    s = { failures: 0, trippedAt: 0 };
    state.set(keyId, s);
  }
  return s;
}

export function noteKeyFailure(keyId: number): void {
  const s = getOrInit(keyId);
  s.failures++;
  if (s.failures >= TRIP_COUNT) s.trippedAt = Date.now();
}

export function noteKeySuccess(keyId: number): void {
  const s = state.get(keyId);
  if (!s) return;
  s.failures = 0;
  s.trippedAt = 0;
}

export function isKeyTripped(keyId: number): boolean {
  const s = state.get(keyId);
  if (!s || s.trippedAt === 0) return false;
  if (Date.now() - s.trippedAt < COOLDOWN_MS) return true;
  // Cooldown expired — clear and let the next call try.
  s.failures = 0;
  s.trippedAt = 0;
  return false;
}

// Convenience helper — record success/failure based on an elapsed
// wall-clock (ms) and an explicit failure flag. Used by poll/scrape
// loops that want a single line at the end of each iteration.
export function noteKeyOutcome(
  keyId: number,
  elapsedMs: number,
  failed: boolean,
): void {
  if (failed || elapsedMs > FAILURE_LATENCY_MS) noteKeyFailure(keyId);
  else noteKeySuccess(keyId);
}

// For audit logs and debug snapshots.
export function snapshot(): Array<{
  keyId: number;
  failures: number;
  tripped: boolean;
  cooldownRemainingMs: number;
}> {
  return Array.from(state.entries()).map(([keyId, s]) => ({
    keyId,
    failures: s.failures,
    tripped: s.trippedAt !== 0 && Date.now() - s.trippedAt < COOLDOWN_MS,
    cooldownRemainingMs:
      s.trippedAt === 0
        ? 0
        : Math.max(0, COOLDOWN_MS - (Date.now() - s.trippedAt)),
  }));
}
