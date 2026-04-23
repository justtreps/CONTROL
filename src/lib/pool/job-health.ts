// Stuck-job detection. Ends a job with status='stuck' + a
// human-readable reason when the worker is technically alive but
// can't make forward progress. Three criteria:
//
//   budget_exhausted        — callsUsed hit the RapidAPI ceiling for
//                             the job type and the target wasn't
//                             reached. Relaunching with a fresh
//                             budget is the sane next step.
//   rate_limited_by_rapidapi — a majority of recent errors are 429s
//                             and no counter moved during this
//                             tranche. Provider throttling; back off
//                             + human review.
//   stale_no_progress       — no counter has moved in 30 min. Catches
//                             the long-tail case where a worker is
//                             looping on some pathological input
//                             without surfacing errors.

import type { PoolJob, PoolConfig, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type StuckReason =
  | "budget_exhausted"
  | "rate_limited_by_rapidapi"
  | "stale_no_progress";

const STUCK_REASON_LABEL_FR: Record<StuckReason, string> = {
  budget_exhausted: "BUDGET API ATTEINT",
  rate_limited_by_rapidapi: "LIMITE RAPIDAPI PAR SECONDE ATTEINTE",
  stale_no_progress: "AUCUNE PROGRESSION DEPUIS 30 MIN",
};

export function stuckReasonLabel(reason: StuckReason | string): string {
  return (
    STUCK_REASON_LABEL_FR[reason as StuckReason] ??
    `STUCK · ${reason.toUpperCase()}`
  );
}

const STALE_MS = 30 * 60_000;
const RATE_LIMIT_MIN_COUNT = 10;

// What a tranche worker snapshots before running so detectStuck can
// tell if this tick made any forward progress.
export type ProgressSnapshot = {
  callsUsed: number;
  primaryProgress: number; // type-specific: addedA+addedB, addedPosts, checked, totalAdded
  errorCount: number;
};

// Extract a comparable progress metric from any job type's stats.
export function snapshotProgress(
  jobType: string,
  stats: Record<string, unknown> | null
): ProgressSnapshot {
  const s = (stats ?? {}) as Record<string, number | unknown[]>;
  const callsUsed =
    typeof s.callsUsed === "number"
      ? s.callsUsed
      : nestedCallsUsed(s);
  const primary = primaryMetric(jobType, s);
  const errorCount = Array.isArray(s.errors) ? s.errors.length : 0;
  return { callsUsed, primaryProgress: primary, errorCount };
}

function nestedCallsUsed(s: Record<string, unknown>): number {
  // engagement_fill nests extract + scrape stats; sum their call
  // counts so the snapshot reflects the true cost.
  let total = 0;
  const ext = s.extract as Record<string, number> | undefined;
  const scr = s.scrape as Record<string, number> | undefined;
  if (ext && typeof ext.callsUsed === "number") total += ext.callsUsed;
  if (scr && typeof scr.callsUsed === "number") total += scr.callsUsed;
  return total;
}

function primaryMetric(
  jobType: string,
  s: Record<string, unknown>
): number {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  switch (jobType) {
    case "scrape":
      return n(s.addedA) + n(s.addedB);
    case "health_check":
      return n(s.checked);
    case "engagement_extract":
      return n(s.addedPosts);
    case "engagement_fill":
      return n(s.totalAdded);
    default:
      return 0;
  }
}

function jobBudget(
  jobType: string,
  cfg: Pick<
    PoolConfig,
    "maxRapidapiCallsPerScrapeRun" | "maxRapidapiCallsPerHealthcheck"
  >
): number | null {
  switch (jobType) {
    case "scrape":
    case "engagement_extract":
    case "engagement_fill":
      return cfg.maxRapidapiCallsPerScrapeRun;
    case "health_check":
      return cfg.maxRapidapiCallsPerHealthcheck;
    default:
      return null;
  }
}

function target(stats: Record<string, unknown>): number {
  const t = stats.target;
  if (typeof t === "number" && t > 0) return t;
  const b = stats.batchSize;
  if (typeof b === "number" && b > 0) return b;
  return Infinity;
}

function isRateLimitError(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("rate-limit") ||
    s.includes("too many requests") ||
    s.includes("429")
  );
}

export function detectStuck({
  job,
  stats,
  cfg,
  before,
  after,
}: {
  job: Pick<PoolJob, "jobType" | "startedAt">;
  stats: Record<string, unknown> | null;
  cfg: Pick<
    PoolConfig,
    "maxRapidapiCallsPerScrapeRun" | "maxRapidapiCallsPerHealthcheck"
  >;
  before: ProgressSnapshot;
  after: ProgressSnapshot;
}): StuckReason | null {
  if (!stats) return null;
  const s = stats as Record<string, unknown>;

  const budget = jobBudget(job.jobType, cfg);
  const tgt = target(s);
  const progress = after.primaryProgress;
  const progressed = after.primaryProgress > before.primaryProgress;

  // (a) Budget exhausted with work left to do.
  if (budget !== null && after.callsUsed >= budget && progress < tgt) {
    return "budget_exhausted";
  }

  // (b) Rate-limit dominant errors this tick + no progress.
  if (!progressed) {
    const errors = Array.isArray(s.errors) ? (s.errors as string[]) : [];
    // Count 429-ish errors in the last ~20 entries (the tail that
    // this tranche likely just produced).
    const recent = errors.slice(-20);
    const rateLimitCount = recent.filter(isRateLimitError).length;
    if (rateLimitCount >= RATE_LIMIT_MIN_COUNT) {
      return "rate_limited_by_rapidapi";
    }
  }

  // (c) Stale no-progress — 30 min since job started AND no progress
  // was recorded on a prior tranche either (we infer via a stored
  // `lastProgressAt` on stats, updated by updateLastProgress below).
  const lastProgressAt =
    typeof s.lastProgressAt === "string"
      ? new Date(s.lastProgressAt).getTime()
      : job.startedAt.getTime();
  if (!progressed && Date.now() - lastProgressAt >= STALE_MS) {
    return "stale_no_progress";
  }

  return null;
}

// Stamp stats.lastProgressAt whenever a tranche observed forward
// motion. Called after a tranche from each worker. Safe to no-op if
// the caller forgets — detectStuck falls back to job.startedAt.
export function updateLastProgress(
  stats: Record<string, unknown> | null,
  before: ProgressSnapshot,
  after: ProgressSnapshot
): void {
  if (!stats) return;
  if (
    after.primaryProgress > before.primaryProgress ||
    after.callsUsed > before.callsUsed
  ) {
    (stats as Record<string, unknown>).lastProgressAt = new Date().toISOString();
  }
}

// Periodically persist the live stats snapshot to the PoolJob row
// while a tranche is running, so the UI's 5s poll sees counters
// advance in near real-time instead of jumping at tranche end.
//
// Writes only the `stats` field — status / endedAt / error belong to
// the terminal finalize. Uses an "in-flight" guard so a slow UPDATE
// can't stack re-entries. Failures are swallowed; the terminal
// finalize will re-write the full state anyway.
export function startJobHeartbeat({
  jobId,
  getStats,
  intervalMs = 3000,
}: {
  jobId: number;
  getStats: () => Record<string, unknown>;
  intervalMs?: number;
}): { stop: () => Promise<void> } {
  let inFlight = false;
  let stopped = false;

  const id = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const snap = getStats();
      await prisma.poolJob.update({
        where: { id: jobId },
        data: {
          stats: snap as unknown as Prisma.InputJsonValue,
        },
      });
    } catch {
      /* best-effort — terminal finalize will land the full state */
    } finally {
      inFlight = false;
    }
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

// Runner-side job selection that cooperates with the live heartbeat
// so a dual-dispatched runner (execute + runner fired in parallel
// from the manual trigger) doesn't stomp on an already-running
// worker. Returns null when every candidate is being actively
// hearted — meaning the execute dispatch landed and the runner is
// redundant this tick.
//
// Selection rules, applied in startedAt-asc order:
//   pending                      → take over (no worker started yet)
//   running, no heartbeat yet,
//     age < 10s                  → skip (give execute a grace window)
//   running, fresh heartbeat     → skip (live worker)
//     (lastProgressAt < 15s ago)
//   running, stale / missing
//     heartbeat + age ≥ 10s      → take over (execute crashed or
//                                 never dispatched)
export async function pickJobForRunner(
  jobType: string
): Promise<PoolJob | null> {
  const candidates = await prisma.poolJob.findMany({
    where: {
      jobType,
      status: { in: ["pending", "running"] },
    },
    orderBy: { startedAt: "asc" },
    take: 5,
  });
  const now = Date.now();
  const FRESH_HEARTBEAT_MS = 15_000;
  const FRESH_CREATION_MS = 10_000;

  for (const c of candidates) {
    if (c.status === "pending") return c;
    const s = c.stats as Record<string, unknown> | null;
    const lastProgressAt = s?.lastProgressAt as string | undefined;
    const lastMs = lastProgressAt
      ? new Date(lastProgressAt).getTime()
      : null;
    if (lastMs !== null && now - lastMs < FRESH_HEARTBEAT_MS) {
      // Another worker is actively heartbeating — leave it alone.
      continue;
    }
    if (lastMs === null && now - c.startedAt.getTime() < FRESH_CREATION_MS) {
      // Brand new, execute might still be spinning up — grace window.
      continue;
    }
    return c;
  }
  return null;
}

// Shared finalization helper used by every tranche worker. Given the
// input job + before/after snapshots, it:
//   - stamps lastProgressAt on stats
//   - runs detectStuck
//   - maps to the right finalStatus (stopped | stuck | completed | running)
// The caller then writes stats + status to DB in one update.
export function finalizeTrancheStatus({
  job,
  beforeStats,
  afterStats,
  cfg,
  stopped,
  done,
}: {
  job: Pick<PoolJob, "jobType" | "startedAt">;
  beforeStats: Record<string, unknown> | null;
  afterStats: Record<string, unknown> | null;
  cfg: Pick<
    PoolConfig,
    "maxRapidapiCallsPerScrapeRun" | "maxRapidapiCallsPerHealthcheck"
  >;
  stopped: boolean;
  done: boolean;
}): { finalStatus: string; stuckReason: StuckReason | null } {
  const before = snapshotProgress(job.jobType, beforeStats);
  const after = snapshotProgress(job.jobType, afterStats);
  updateLastProgress(afterStats, before, after);

  const stuckReason =
    !stopped && !done
      ? detectStuck({ job, stats: afterStats, cfg, before, after })
      : null;

  const finalStatus = stopped
    ? "stopped"
    : stuckReason
      ? "stuck"
      : done
        ? "completed"
        : "running";

  return { finalStatus, stuckReason };
}
