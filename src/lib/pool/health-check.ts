// Pool health check — verifies accounts are still virgin.
//
// Iterates through 'available' accounts ordered by lastCheckedAt ASC
// (oldest first), calls the oracle (lib/pool/oracle.ts), and either
// updates counts or invalidates per PoolConfig rules:
//   - ghost (RapidAPI says 'Not found')  → invalid_reason='deleted'
//   - follower_count > threshold          → 'became_active'
//   - media_count > threshold             → 'became_active'
//   - is_private (IG only)                → 'became_private'
//   - oracle returned a different username → UPDATE username in place
//
// Tranche-based like the scraper: checkpoint cursor lives in
// PoolJob.stats so a killed Vercel function resumes cleanly.
//
// If after this batch the pool drops below refill_threshold_* for a
// platform AND auto_refill_enabled=true, a new scrape job is queued.

import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "./config";
import { fetchOracleFor } from "./oracle";

export type HealthStats = {
  platform: "instagram" | "tiktok" | "both";
  checked: number;
  invalidated: number;
  errors: string[];
  callsUsed: number;
  // ISO timestamp set once at job start. Used by the findMany filter
  // `lastCheckedAt < startedAt` so no row already processed in this
  // job gets re-picked — eliminates the 1.8× duplicate-check ratio
  // we observed on job #020.
  startedAt: string;
  // Retained for retro-compat with in-flight jobs' stats JSON.
  lastProcessedId: number;
  batchSize: number;
  queuedRefills: string[]; // platforms that auto-refill fired for
};

export function initHealthStats(
  platform: "instagram" | "tiktok" | "both"
): HealthStats {
  return {
    platform,
    checked: 0,
    invalidated: 0,
    errors: [],
    callsUsed: 0,
    startedAt: new Date().toISOString(),
    lastProcessedId: 0,
    batchSize: 2000,
    queuedRefills: [],
  };
}

// Number of oracle calls fired concurrently per Promise.all wave.
// Matches seeds-health-check's pattern — safe under RapidAPI's
// per-second limits, ~4-5× throughput vs serial.
const CONCURRENCY = 8;

export async function runHealthCheckTranche({
  stats,
  budgetMs,
  stopRequested,
}: {
  stats: HealthStats;
  budgetMs: number;
  stopRequested: () => Promise<boolean>;
}): Promise<{ done: boolean; stats: HealthStats }> {
  const cfg = await getPoolConfig();
  const deadline = Date.now() + budgetMs;

  const platforms: string[] =
    stats.platform === "both" ? ["instagram", "tiktok"] : [stats.platform];

  // Retro-compat: jobs started before this field existed have
  // startedAt === undefined. Fall back to "now - 1h" so they don't
  // accidentally filter out every row.
  const jobStart = stats.startedAt
    ? new Date(stats.startedAt)
    : new Date(Date.now() - 3_600_000);

  while (Date.now() < deadline) {
    if (await stopRequested()) return { done: false, stats };
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerHealthcheck)
      return { done: true, stats };
    if (stats.checked >= stats.batchSize) return { done: true, stats };

    // Pull a wave that's 4× the concurrency so each findMany round
    // feeds multiple parallel batches before we hit the DB again.
    // `lastCheckedAt < jobStart` prevents re-picking rows we've
    // already processed in THIS job (they now have lastCheckedAt=NOW
    // which is >= jobStart).
    const rows = await prisma.testAccount.findMany({
      where: {
        platform: { in: platforms },
        status: "available",
        lastCheckedAt: { lt: jobStart },
      },
      orderBy: { lastCheckedAt: "asc" }, // oldest check first
      take: CONCURRENCY * 4,
    });
    if (rows.length === 0) return { done: true, stats };

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      if (Date.now() > deadline) break;
      if (await stopRequested()) return { done: false, stats };
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((r) => processOneAccount({ row: r, stats, cfg }))
      );
    }
  }

  return { done: false, stats };
}

// Single-row health check: oracle call + DB write + stats increment.
// Extracted so the main loop can dispatch N of these in parallel.
async function processOneAccount({
  row,
  stats,
  cfg,
}: {
  row: { id: number; platform: string; userId: string; username: string };
  stats: HealthStats;
  cfg: {
    maxFollowerCount: number;
    maxFollowingCount: number;
    invalidateIfMediaAbove: number;
    requireNotPrivate: boolean;
  };
}): Promise<void> {
  const oracle = await fetchOracleFor(row.platform, row.userId);
  // Increments on a plain JS object are atomic between awaits — no
  // lock needed despite Promise.all concurrency.
  stats.callsUsed++;
  stats.checked++;

  if (!oracle.ok) {
    if (oracle.reason === "ghost") {
      await prisma.testAccount.update({
        where: { id: row.id },
        data: {
          status: "invalid",
          invalidReason: "deleted",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          active: false,
        },
      });
      stats.invalidated++;
    } else {
      stats.errors.push(`#${row.id}: ${oracle.message.slice(0, 100)}`);
      await prisma.testAccount.update({
        where: { id: row.id },
        data: { lastCheckedAt: new Date() },
      });
    }
    return;
  }

  const renamed =
    oracle.username.length > 0 &&
    oracle.username.toLowerCase() !== row.username.toLowerCase();

  let invalidReason: string | null = null;
  if (oracle.followerCount > cfg.maxFollowerCount)
    invalidReason = "became_active";
  else if (oracle.mediaCount > cfg.invalidateIfMediaAbove)
    invalidReason = "became_active";
  else if (oracle.followingCount > cfg.maxFollowingCount)
    // Parity with the scrape-time filter: if the account starts
    // following far more people than we admit at scrape, it's drifted
    // away from the "virgin" profile we want to test on.
    invalidReason = "became_active";
  else if (row.platform === "instagram" && oracle.isPrivate)
    invalidReason = "became_private";

  await prisma.testAccount.update({
    where: { id: row.id },
    data: invalidReason
      ? {
          status: "invalid",
          invalidReason,
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          active: false,
          ...(renamed ? { username: oracle.username } : {}),
        }
      : {
          lastCheckedAt: new Date(),
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          ...(renamed ? { username: oracle.username } : {}),
        },
  });
  if (invalidReason) stats.invalidated++;
}

// Post-batch: if any platform's available pool fell under its threshold,
// queue a scrape job with trigger=auto_refill. Idempotent — won't queue if
// one is already pending.
export async function maybeQueueAutoRefill(
  stats: HealthStats
): Promise<void> {
  const cfg = await getPoolConfig();
  if (!cfg.autoRefillEnabled) return;

  for (const p of ["instagram", "tiktok"] as const) {
    const threshold =
      p === "instagram" ? cfg.refillThresholdInstagram : cfg.refillThresholdTiktok;
    const target =
      p === "instagram" ? cfg.refillTargetInstagram : cfg.refillTargetTiktok;

    const available = await prisma.testAccount.count({
      where: { platform: p, status: "available" },
    });
    if (available >= threshold) continue;

    const alreadyQueued = await prisma.poolJob.findFirst({
      where: {
        jobType: "scrape",
        platform: p,
        status: { in: ["pending", "running"] },
      },
    });
    if (alreadyQueued) continue;

    await prisma.poolJob.create({
      data: {
        jobType: "scrape",
        platform: p,
        trigger: "auto_refill",
        status: "pending",
        stats: {
          target,
          platform: p,
          phase: "a",
          addedA: 0,
          addedB: 0,
          callsUsed: 0,
          errors: [],
          a: {
            doneSeedIds: [],
            currentSeedId: null,
            seedPlatform: null,
            pagesDone: 0,
          },
          b: { attempts: 0 },
        },
      },
    });
    stats.queuedRefills.push(p);
  }
}
