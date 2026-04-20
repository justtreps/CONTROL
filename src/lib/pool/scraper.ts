// Pool scraper — tranche-based, resumable, stop-respecting.
//
// Each tranche (called by the orchestrator every minute with ~8s budget)
// picks ONE seed from PoolSeedAccount and scrapes one page of its
// followers. Phase A flow per candidate:
//   1. Prefilter with what /followers already gives us — reject if
//      private / verified.
//   2. Call /user/info to get followers/media/following counts (1 extra
//      call per candidate; only fires when the prefilter passed).
//   3. Strict qualify against PoolConfig thresholds.
//   4. Upsert as status='available' WITH counts stored.
// Every rejection is counted by reason in stats.candidatesRejected so
// operators can see exactly why a run produced few accounts.
//
// Method B (random-username probes) remains a stub — not a priority yet.

import { prisma } from "@/lib/prisma";
import {
  fetchInstagramFollowers,
  fetchInstagramUserInfo,
} from "@/lib/rapidapi/instagram";
import {
  fetchTikTokFollowers,
  fetchTikTokUserByUsername,
} from "@/lib/rapidapi/tiktok";
import { getPoolConfig } from "./config";

export type RejectionBreakdown = {
  private: number;
  verified: number;
  too_many_followers: number;
  too_much_media: number;
  too_many_following: number;
  fetch_info_failed: number;
  other: number;
};

function emptyRejections(): RejectionBreakdown {
  return {
    private: 0,
    verified: 0,
    too_many_followers: 0,
    too_much_media: 0,
    too_many_following: 0,
    fetch_info_failed: 0,
    other: 0,
  };
}

export type ScrapeStats = {
  target: number;
  platform: "instagram" | "tiktok" | "both";
  phase: "a" | "b";
  addedA: number;
  addedB: number;
  callsUsed: number;
  seedsProcessed: number;
  candidatesFetched: number;
  candidatesQualified: number;
  candidatesRejected: RejectionBreakdown;
  errors: string[];
  // Phase A checkpoint
  a: {
    doneSeedIds: number[];
    currentSeedId: number | null;
    seedPlatform: string | null;
    pagesDone: number;
  };
  // Phase B checkpoint
  b: {
    attempts: number;
  };
};

export function initScrapeStats(
  platform: "instagram" | "tiktok" | "both",
  target: number
): ScrapeStats {
  return {
    target,
    platform,
    phase: "a",
    addedA: 0,
    addedB: 0,
    callsUsed: 0,
    seedsProcessed: 0,
    candidatesFetched: 0,
    candidatesQualified: 0,
    candidatesRejected: emptyRejections(),
    errors: [],
    a: {
      doneSeedIds: [],
      currentSeedId: null,
      seedPlatform: null,
      pagesDone: 0,
    },
    b: { attempts: 0 },
  };
}

// Retro-compat: old in-flight jobs may have stats without the new
// counters. Hydrate missing fields so the scraper doesn't crash.
function ensureStatsShape(s: ScrapeStats): ScrapeStats {
  if (typeof s.seedsProcessed !== "number") s.seedsProcessed = 0;
  if (typeof s.candidatesFetched !== "number") s.candidatesFetched = 0;
  if (typeof s.candidatesQualified !== "number") s.candidatesQualified = 0;
  if (!s.candidatesRejected) s.candidatesRejected = emptyRejections();
  else {
    const r = s.candidatesRejected;
    for (const k of Object.keys(emptyRejections()) as Array<keyof RejectionBreakdown>) {
      if (typeof r[k] !== "number") r[k] = 0;
    }
  }
  return s;
}

async function pickNextSeed(
  platform: "instagram" | "tiktok",
  excludeIds: number[]
) {
  return prisma.poolSeedAccount.findFirst({
    where: {
      platform,
      enabled: true,
      id: { notIn: excludeIds.length > 0 ? excludeIds : [-1] },
    },
    orderBy: [{ priority: "desc" }, { addedAt: "asc" }],
  });
}

export async function runScrapeTranche({
  stats,
  budgetMs,
  stopRequested,
}: {
  stats: ScrapeStats;
  budgetMs: number;
  stopRequested: () => Promise<boolean>;
}): Promise<{ done: boolean; stats: ScrapeStats }> {
  ensureStatsShape(stats);
  const cfg = await getPoolConfig();
  const deadline = Date.now() + budgetMs;

  const platformsToRun: Array<"instagram" | "tiktok"> =
    stats.platform === "both"
      ? ["instagram", "tiktok"]
      : [stats.platform];

  const wantA = Math.max(1, Math.round(stats.target * cfg.methodARatio));
  const totalAdded = () => stats.addedA + stats.addedB;

  // --- Phase A ---------------------------------------------------------
  if (stats.phase === "a") {
    while (totalAdded() < wantA) {
      if (Date.now() > deadline) return { done: false, stats };
      if (await stopRequested()) return { done: false, stats };
      if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) break;

      // If no current seed, pick the next one.
      if (!stats.a.currentSeedId) {
        const pickFor =
          platformsToRun[stats.a.doneSeedIds.length % platformsToRun.length];
        const seed = await pickNextSeed(pickFor, stats.a.doneSeedIds);
        if (!seed) {
          // Rotate to any other available platform.
          const remaining = platformsToRun.filter((p) => p !== pickFor);
          let replaced = false;
          for (const p of remaining) {
            const s = await pickNextSeed(p, stats.a.doneSeedIds);
            if (s) {
              stats.a.currentSeedId = s.id;
              stats.a.seedPlatform = s.platform;
              stats.a.pagesDone = 0;
              replaced = true;
              break;
            }
          }
          if (!replaced) break; // No more seeds — advance to Phase B.
        } else {
          stats.a.currentSeedId = seed.id;
          stats.a.seedPlatform = seed.platform;
          stats.a.pagesDone = 0;
        }
      }

      const seed = await prisma.poolSeedAccount.findUnique({
        where: { id: stats.a.currentSeedId! },
      });
      if (!seed) {
        stats.a.currentSeedId = null;
        continue;
      }

      try {
        if (seed.platform === "instagram") {
          await processInstagramSeed({ seed, stats, cfg });
        } else if (seed.platform === "tiktok") {
          await processTikTokSeed({ seed, stats, cfg });
        }
      } catch (e) {
        stats.errors.push(
          `seed ${seed.username}/${seed.platform}: ${(e as Error).message.slice(0, 160)}`
        );
      }

      // Close this seed (one page per run for now; multi-page needs a
      // cursor we don't have yet).
      if (stats.a.pagesDone >= cfg.maxPagesPerSeed || stats.a.pagesDone >= 1) {
        stats.a.doneSeedIds.push(stats.a.currentSeedId!);
        stats.seedsProcessed++;
        stats.a.currentSeedId = null;
        stats.a.seedPlatform = null;
      }
    }
    stats.phase = "b";
  }

  // --- Phase B (random-username probes) ------------------------------
  // MVP stub. Left noop until a generic user-info-by-username helper
  // exists for method B; Phase A with relaxed thresholds already gives
  // us a working pool.
  if (stats.phase === "b") {
    // noop
  }

  const reachedTarget = totalAdded() >= stats.target;
  const exhausted = stats.phase === "b";
  return { done: reachedTarget || exhausted, stats };
}

// ---------- Instagram branch ----------------------------------------------

async function processInstagramSeed({
  seed,
  stats,
  cfg,
}: {
  seed: { id: number; username: string; platform: string };
  stats: ScrapeStats;
  cfg: {
    requireNotPrivate: boolean;
    maxFollowerCount: number;
    maxMediaCount: number;
    maxFollowingCount: number;
    maxRapidapiCallsPerScrapeRun: number;
  };
}) {
  const { sample } = await fetchInstagramFollowers(seed.username);
  stats.callsUsed++;

  for (const f of sample) {
    stats.candidatesFetched++;

    // Prefilter: is_verified is a hard NO; private depends on config.
    if (f.is_verified) {
      stats.candidatesRejected.verified++;
      continue;
    }
    if (cfg.requireNotPrivate && f.is_private) {
      stats.candidatesRejected.private++;
      continue;
    }

    // Quota guard — never overrun the per-run budget.
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) {
      stats.candidatesRejected.other++;
      continue;
    }

    // Deep fetch for counts.
    let info;
    try {
      info = await fetchInstagramUserInfo(f.username);
      stats.callsUsed++;
    } catch (e) {
      stats.candidatesRejected.fetch_info_failed++;
      stats.errors.push(
        `user_info @${f.username}: ${(e as Error).message.slice(0, 120)}`
      );
      continue;
    }

    if (cfg.requireNotPrivate && info.isPrivate) {
      stats.candidatesRejected.private++;
      continue;
    }
    if (info.followerCount > cfg.maxFollowerCount) {
      stats.candidatesRejected.too_many_followers++;
      continue;
    }
    if (info.mediaCount > cfg.maxMediaCount) {
      stats.candidatesRejected.too_much_media++;
      continue;
    }
    if (info.followingCount > cfg.maxFollowingCount) {
      stats.candidatesRejected.too_many_following++;
      continue;
    }

    // Qualified — upsert with real counts.
    const res = await prisma.testAccount.upsert({
      where: { platform_username: { platform: "instagram", username: f.username } },
      update: {},
      create: {
        platform: "instagram",
        username: f.username,
        userId: f.id,
        status: "available",
        lastFollowerCount: info.followerCount,
        lastMediaCount: info.mediaCount,
        lastFollowingCount: info.followingCount,
        scrapeSource: "big_account_followers",
        scrapeSeedAccount: seed.username,
      },
    });
    if (res.firstSeenAt.getTime() > Date.now() - 2000) {
      stats.addedA++;
      stats.candidatesQualified++;
    }
  }

  stats.a.pagesDone++;
}

// ---------- TikTok branch -------------------------------------------------
// TT follower API already returns follower/following/media counts per
// follower, so we get everything from a single `/user/followers` call
// per seed (plus 1 call to resolve the seed's numeric user_id).

async function processTikTokSeed({
  seed,
  stats,
  cfg,
}: {
  seed: { id: number; username: string; platform: string };
  stats: ScrapeStats;
  cfg: {
    maxFollowerCount: number;
    maxMediaCount: number;
    maxFollowingCount: number;
  };
}) {
  const info = await fetchTikTokUserByUsername(seed.username);
  stats.callsUsed++;
  const { sample } = await fetchTikTokFollowers(info.userId);
  stats.callsUsed++;

  for (const f of sample) {
    stats.candidatesFetched++;

    if (f.follower_count > cfg.maxFollowerCount) {
      stats.candidatesRejected.too_many_followers++;
      continue;
    }
    if (f.aweme_count > cfg.maxMediaCount) {
      stats.candidatesRejected.too_much_media++;
      continue;
    }
    if (f.following_count > cfg.maxFollowingCount) {
      stats.candidatesRejected.too_many_following++;
      continue;
    }

    const res = await prisma.testAccount.upsert({
      where: {
        platform_username: {
          platform: "tiktok",
          username: f.unique_id,
        },
      },
      update: {},
      create: {
        platform: "tiktok",
        username: f.unique_id,
        userId: f.id,
        status: "available",
        lastFollowerCount: f.follower_count,
        lastMediaCount: f.aweme_count,
        lastFollowingCount: f.following_count,
        scrapeSource: "big_account_followers",
        scrapeSeedAccount: seed.username,
      },
    });
    if (res.firstSeenAt.getTime() > Date.now() - 2000) {
      stats.addedA++;
      stats.candidatesQualified++;
    }
  }

  stats.a.pagesDone++;
}
