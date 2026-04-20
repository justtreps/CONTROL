// Pool scraper — tranche-based, resumable, stop-respecting.
//
// Each tranche (called by the orchestrator every minute with ~8s budget)
// picks ONE seed from PoolSeedAccount and scrapes one page of its
// followers, OR runs a batch of method-B random-username probes. State
// is checkpointed in PoolJob.stats so the next tranche resumes exactly
// where this one stopped.
//
// Candidates are upserted as 'available' with minimal info — the
// health check (lib/pool/health-check.ts) is the authoritative gate
// that validates follower/media counts against PoolConfig thresholds
// and invalidates rows that don't qualify.
//
// This keeps Method A cheap: one RapidAPI call per seed per tranche.
// For faster pool builds, trigger multiple scrape jobs in parallel.

import { prisma } from "@/lib/prisma";
import { fetchInstagramFollowers } from "@/lib/rapidapi/instagram";
import { fetchTikTokFollowers } from "@/lib/rapidapi/tiktok";
import { getPoolConfig } from "./config";

export type ScrapeStats = {
  target: number;
  platform: "instagram" | "tiktok" | "both";
  phase: "a" | "b";
  addedA: number;
  addedB: number;
  callsUsed: number;
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

// Run ~one tranche (≤ budgetMs). Mutates and returns the stats.
// Returns { done: true } once the target is reached or both phases exhausted.
export async function runScrapeTranche({
  stats,
  budgetMs,
  stopRequested,
}: {
  stats: ScrapeStats;
  budgetMs: number;
  stopRequested: () => Promise<boolean>;
}): Promise<{ done: boolean; stats: ScrapeStats }> {
  const cfg = await getPoolConfig();
  const deadline = Date.now() + budgetMs;

  const platformsToRun: Array<"instagram" | "tiktok"> =
    stats.platform === "both"
      ? ["instagram", "tiktok"]
      : [stats.platform];

  const wantA = Math.max(1, Math.round(stats.target * cfg.methodARatio));

  // Convenience: how many rows we've actually added so far.
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
          // No more seeds for this platform — try the other one(s).
          const remaining = platformsToRun.filter(
            (p) =>
              p !== pickFor /* in mixed mode rotate through others */
          );
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
          if (!replaced) {
            // No more usable seeds — move to Phase B.
            break;
          }
        } else {
          stats.a.currentSeedId = seed.id;
          stats.a.seedPlatform = seed.platform;
          stats.a.pagesDone = 0;
        }
      }

      // Scrape one page for the current seed.
      const seed = await prisma.poolSeedAccount.findUnique({
        where: { id: stats.a.currentSeedId! },
      });
      if (!seed) {
        stats.a.currentSeedId = null;
        continue;
      }

      try {
        if (seed.platform === "instagram") {
          const { sample } = await fetchInstagramFollowers(seed.username);
          stats.callsUsed++;
          let added = 0;
          for (const f of sample) {
            if (cfg.requireNotPrivate && f.is_private) continue;
            const res = await prisma.testAccount.upsert({
              where: { platform_username: { platform: "instagram", username: f.username } },
              update: {}, // already in DB, leave as-is
              create: {
                platform: "instagram",
                username: f.username,
                userId: f.id,
                status: "available",
                scrapeSource: "big_account_followers",
                scrapeSeedAccount: seed.username,
              },
            });
            if (res.firstSeenAt.getTime() > Date.now() - 2000) added++;
          }
          stats.addedA += added;
          stats.a.pagesDone++;
        } else if (seed.platform === "tiktok") {
          const { sample } = await fetchTikTokFollowers(seed.username);
          stats.callsUsed++;
          let added = 0;
          for (const f of sample) {
            if (cfg.requireNotPrivate /* tiktok followers don't expose is_private */) {
              // skip — TikTok follower API doesn't give is_private per follower
            }
            if (
              f.follower_count > cfg.maxFollowerCount ||
              f.aweme_count > cfg.maxMediaCount ||
              f.following_count > cfg.maxFollowingCount
            ) {
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
            if (res.firstSeenAt.getTime() > Date.now() - 2000) added++;
          }
          stats.addedA += added;
          stats.a.pagesDone++;
        }
      } catch (e) {
        stats.errors.push(
          `seed ${seed.username}/${seed.platform}: ${(e as Error).message.slice(0, 120)}`
        );
      }

      // One page per seed for now (cursor support = future improvement).
      if (stats.a.pagesDone >= cfg.maxPagesPerSeed || stats.a.pagesDone >= 1) {
        stats.a.doneSeedIds.push(stats.a.currentSeedId!);
        stats.a.currentSeedId = null;
        stats.a.seedPlatform = null;
      }
    }
    stats.phase = "b";
  }

  // --- Phase B (random-username probes) ------------------------------
  // MVP: skipped for now — the IG/TT rapidapi helpers don't expose a
  // reliable user-info-by-username endpoint yet. Method-A alone builds
  // a pool from the seeds' followers lists.
  if (stats.phase === "b") {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _attempts = stats.b.attempts;
    // Intentional no-op until rapidapi user_info is wired.
  }

  const reachedTarget = totalAdded() >= stats.target;
  const exhausted = stats.phase === "b"; // phase B currently no-op => we're done

  return { done: reachedTarget || exhausted, stats };
}
