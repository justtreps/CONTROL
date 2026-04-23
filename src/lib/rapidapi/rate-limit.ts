// Global rate limiter for Instagram RapidAPI calls.
//
// Plan ceiling: MEGA = 100 req/min per key. We set a hard cap 15%
// below that (85 req/min) to absorb burst overhead from the RapidAPI
// edge + leave room for manual debug curls without tripping the
// limit. The scraper, health check, engagement extract, engagement
// fill, rechecks + seeds health check all share this one limiter.
//
// Scope: in-process sliding window. Shared across every function
// inside ONE Vercel invocation (one scrape-execute lives 280s and
// can easily burn 200+ IG calls in that window). Parallel Vercel
// invocations run in separate processes and each gets its own budget
// — in practice the concurrent worker count is small (3-4 at most
// during a heavy cycle) so the combined ceiling stays roughly below
// the MEGA plan limit. If we ever need strict cross-instance quota,
// swap the internal array for an Upstash Redis sorted-set; the
// public API stays identical.
//
// Only IG is gated. TikTok's ULTRA plan is roomy enough that the
// per-call overhead isn't worth the coordination cost.

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 85;

// Timestamps (ms) of the last ≤ MAX_REQUESTS_PER_WINDOW calls.
// Maintained as a sorted array — cheaper than a real min-heap at
// this scale (≤85 entries).
const windowTimestamps: number[] = [];

// Promise chain that guarantees FIFO acquisition even when many
// callers await in parallel. Without it, Promise.all(callers) would
// all see the same "free slot" state and race past the limit.
let chain: Promise<void> = Promise.resolve();

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (windowTimestamps.length && windowTimestamps[0] < cutoff) {
    windowTimestamps.shift();
  }
}

async function acquireSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    prune(now);
    if (windowTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
      windowTimestamps.push(now);
      return;
    }
    // Wait until the oldest timestamp falls outside the window, +50ms
    // safety margin so we don't micro-race on the cutoff boundary.
    const waitMs = WINDOW_MS - (now - windowTimestamps[0]) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Public API — every IG call site awaits this before fetch(). The
// chain serialises acquisition so N parallel callers line up in
// strict FIFO order; once a caller holds a slot the subsequent
// `fetch` runs in parallel with other holders.
export async function waitForIgSlot(): Promise<void> {
  const prev = chain;
  let release: () => void = () => {};
  chain = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    await acquireSlot();
  } finally {
    release();
  }
}

// Small helper for tests / introspection.
export function ig429SnapshotForDebug(): {
  inFlightWindowSize: number;
  maxPerWindow: number;
} {
  prune(Date.now());
  return {
    inFlightWindowSize: windowTimestamps.length,
    maxPerWindow: MAX_REQUESTS_PER_WINDOW,
  };
}
