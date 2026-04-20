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
  // Checkpoint: last processed account id (we iterate id ASC within a batch).
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
    lastProcessedId: 0,
    batchSize: 500,
    queuedRefills: [],
  };
}

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

  while (Date.now() < deadline) {
    if (await stopRequested()) return { done: false, stats };
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerHealthcheck)
      return { done: true, stats };
    if (stats.checked >= stats.batchSize) return { done: true, stats };

    const rows = await prisma.testAccount.findMany({
      where: {
        platform: { in: platforms },
        status: "available",
        id: { gt: stats.lastProcessedId },
      },
      orderBy: { id: "asc" },
      take: 10,
    });
    if (rows.length === 0) return { done: true, stats };

    for (const r of rows) {
      if (Date.now() > deadline) break;

      const oracle = await fetchOracleFor(r.platform, r.userId);
      stats.callsUsed++;
      stats.checked++;
      stats.lastProcessedId = r.id;

      if (!oracle.ok) {
        if (oracle.reason === "ghost") {
          await prisma.testAccount.update({
            where: { id: r.id },
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
          stats.errors.push(`#${r.id}: ${oracle.message.slice(0, 100)}`);
          await prisma.testAccount.update({
            where: { id: r.id },
            data: { lastCheckedAt: new Date() },
          });
        }
        continue;
      }

      // Track username drift so the row stays addressable by the CURRENT
      // handle (needed for BulkMedya link construction).
      const renamed =
        oracle.username.length > 0 &&
        oracle.username.toLowerCase() !== r.username.toLowerCase();

      let invalidReason: string | null = null;
      if (oracle.followerCount > cfg.invalidateIfFollowerAbove)
        invalidReason = "became_active";
      else if (oracle.mediaCount > cfg.invalidateIfMediaAbove)
        invalidReason = "became_active";
      else if (r.platform === "instagram" && oracle.isPrivate)
        invalidReason = "became_private";

      await prisma.testAccount.update({
        where: { id: r.id },
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
  }

  return { done: false, stats };
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
