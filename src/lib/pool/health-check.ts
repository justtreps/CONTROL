// Pool health check — verifies accounts are still virgin.
//
// Iterates through 'available' accounts ordered by lastCheckedAt ASC
// (oldest first), calls RapidAPI user-info, and either updates the
// counts or invalidates the row per PoolConfig rules:
//   - 404 / persistent error  → invalid_reason='deleted'
//   - follower > threshold     → 'became_active'
//   - media > threshold        → 'became_active'
//   - is_private (IG only)     → 'became_private'
//
// Tranche-based like the scraper: checkpoint cursor lives in
// PoolJob.stats so a killed Vercel function resumes cleanly.
//
// If after this batch the pool drops below refill_threshold_* for a
// platform AND auto_refill_enabled=true, a new scrape job is queued.

import { prisma } from "@/lib/prisma";
import {
  fetchInstagramFollowers,
} from "@/lib/rapidapi/instagram";
import { fetchTikTokFollowers } from "@/lib/rapidapi/tiktok";
import { getPoolConfig } from "./config";

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

// For MVP we re-use fetchInstagramFollowers/fetchTikTokFollowers as a
// coarse liveness check on the ACCOUNT's own handle (it confirms the
// profile exists + gives an approximate follower count on the top of
// the response). When we add a proper user-info RapidAPI endpoint
// we'll swap this for a single lightweight call per account.
async function probe(
  platform: string,
  username: string,
  userId: string
): Promise<{
  ok: true;
  followerCount: number;
  mediaCount: number;
  followingCount: number;
  isPrivate: boolean;
} | { ok: false; status: "deleted" | "other"; message: string }> {
  try {
    if (platform === "instagram") {
      const { count, sample } = await fetchInstagramFollowers(username);
      // We don't have per-account media/following from this endpoint — leave
      // media/following at 0 so only follower_count + is_private are checked.
      const first = sample[0];
      return {
        ok: true,
        followerCount: count,
        mediaCount: 0,
        followingCount: 0,
        isPrivate: Boolean(first?.is_private),
      };
    }
    if (platform === "tiktok") {
      const { count } = await fetchTikTokFollowers(userId);
      return {
        ok: true,
        followerCount: count,
        mediaCount: 0,
        followingCount: 0,
        isPrivate: false,
      };
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) {
      return { ok: false, status: "deleted", message: msg };
    }
    return { ok: false, status: "other", message: msg };
  }
  return { ok: false, status: "other", message: "unsupported platform" };
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

  // Within each tranche, pull a small sub-batch (10 accounts) and process.
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

      const res = await probe(r.platform, r.username, r.userId);
      stats.callsUsed++;
      stats.checked++;
      stats.lastProcessedId = r.id;

      if (!res.ok) {
        if (res.status === "deleted") {
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
          stats.errors.push(`#${r.id}: ${res.message.slice(0, 100)}`);
          await prisma.testAccount.update({
            where: { id: r.id },
            data: { lastCheckedAt: new Date() },
          });
        }
        continue;
      }

      // Qualify against rules
      let invalidReason: string | null = null;
      if (res.followerCount > cfg.invalidateIfFollowerAbove) invalidReason = "became_active";
      else if (res.mediaCount > cfg.invalidateIfMediaAbove) invalidReason = "became_active";
      else if (r.platform === "instagram" && res.isPrivate) invalidReason = "became_private";

      await prisma.testAccount.update({
        where: { id: r.id },
        data: invalidReason
          ? {
              status: "invalid",
              invalidReason,
              invalidatedAt: new Date(),
              lastCheckedAt: new Date(),
              lastFollowerCount: res.followerCount,
              lastMediaCount: res.mediaCount,
              lastFollowingCount: res.followingCount,
              active: false,
            }
          : {
              lastCheckedAt: new Date(),
              lastFollowerCount: res.followerCount,
              lastMediaCount: res.mediaCount,
              lastFollowingCount: res.followingCount,
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
