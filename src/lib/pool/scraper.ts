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
import { fetchInstagramFollowers } from "@/lib/rapidapi/instagram";
import {
  fetchTikTokFollowers,
  fetchTikTokUserByUsername,
} from "@/lib/rapidapi/tiktok";
import { fetchIgOracle, fetchTtOracle } from "./oracle";
import { getPoolConfig } from "./config";

export type RejectionBreakdown = {
  private: number;
  verified: number;
  too_many_followers: number;
  too_much_media: number;
  too_many_following: number;
  fetch_info_failed: number;
  ghost: number;
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
    ghost: 0,
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
  // True if Phase B was skipped because the methodBEnabled global
  // toggle was off at tranche time. Set once and surfaced in the UI so
  // operators can see "no B accounts because Method B is disabled"
  // rather than thinking the phase silently failed.
  phaseBSkipped?: boolean;
  // Phase A checkpoint
  a: {
    doneSeedIds: number[];
    currentSeedId: number | null;
    seedPlatform: string | null;
    pagesDone: number;
    // Per-seed error streak WITHIN this job. Prevents the bug where a
    // seed that throws every attempt (e.g. a private account locked
    // against the follower API) gets re-picked forever because
    // pagesDone never increments. After MAX_ERRORS_PER_SEED_RUN we
    // force-close the seed for this run regardless of pagesDone.
    seedErrorCount?: Record<number, number>;
  };
  // Phase B checkpoint
  b: {
    attempts: number;
  };
};

// If a single seed errors this many times within one job, we force-
// close it (doneSeedIds.push + move on). Independent of the cross-run
// PoolSeedAccount.consecutiveErrors tracker — this is just the safety
// net so a single bad seed can't burn an entire run.
const MAX_ERRORS_PER_SEED_RUN = 5;

// If PoolSeedAccount.consecutiveErrors reaches this across runs AND
// the latest error looks like a "Private account" message, we flip
// enabled=false so the seed is ignored until an operator re-enables
// it. Three strikes rules out the rare transient mislabel.
const AUTO_DISABLE_PRIVATE_THRESHOLD = 3;

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
      seedErrorCount: {},
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
  if (!s.a.seedErrorCount) s.a.seedErrorCount = {};
  return s;
}

// Regex matching the various wordings providers use when a seed's
// follower list is inaccessible because the account went private /
// locked / restricted. Conservative — we only auto-disable on these
// unambiguous signals.
const PRIVATE_ACCOUNT_RX =
  /private\s+account|account\s+is\s+private|this\s+account\s+is\s+private|is_private/i;

function isPrivateLikeError(msg: string): boolean {
  return PRIVATE_ACCOUNT_RX.test(msg);
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

      let seedErrored = false;
      let autoDisabled = false;
      try {
        if (seed.platform === "instagram") {
          await processInstagramSeed({ seed, stats, cfg });
        } else if (seed.platform === "tiktok") {
          await processTikTokSeed({ seed, stats, cfg });
        }
        // Success path — reset the cross-run error streak if non-zero.
        if ((seed.consecutiveErrors ?? 0) > 0) {
          await prisma.poolSeedAccount.update({
            where: { id: seed.id },
            data: { consecutiveErrors: 0, lastErrorReason: null },
          });
        }
      } catch (e) {
        seedErrored = true;
        const msg = (e as Error).message;
        stats.errors.push(
          `seed ${seed.username}/${seed.platform}: ${msg.slice(0, 160)}`
        );

        // Bump in-job counter (prevents infinite retry within this run).
        if (!stats.a.seedErrorCount) stats.a.seedErrorCount = {};
        stats.a.seedErrorCount[seed.id] =
          (stats.a.seedErrorCount[seed.id] ?? 0) + 1;

        // Bump cross-run counter and, if this is the N-th consecutive
        // "Private account" signal, auto-disable the seed.
        const newStreak = (seed.consecutiveErrors ?? 0) + 1;
        const privateSignal = isPrivateLikeError(msg);
        if (
          privateSignal &&
          newStreak >= AUTO_DISABLE_PRIVATE_THRESHOLD
        ) {
          await prisma.poolSeedAccount.update({
            where: { id: seed.id },
            data: {
              enabled: false,
              consecutiveErrors: newStreak,
              lastErrorReason: msg.slice(0, 200),
            },
          });
          await prisma.poolSeedHealthLog.create({
            data: {
              platform: seed.platform,
              action: "auto_disabled_private",
              seedUsername: seed.username,
              reason: `${newStreak} consecutive private errors · last: ${msg.slice(0, 150)}`,
            },
          });
          console.error(
            `[SCRAPER] Auto-disabled seed @${seed.username} (${seed.platform}) after ${newStreak} consecutive private errors`
          );
          autoDisabled = true;
        } else {
          await prisma.poolSeedAccount.update({
            where: { id: seed.id },
            data: {
              consecutiveErrors: newStreak,
              lastErrorReason: msg.slice(0, 200),
            },
          });
        }
      }

      // Close the seed when:
      //  • it completed a page (happy path), OR
      //  • it got auto-disabled, OR
      //  • it errored too many times within this run (safety net).
      const runtimeErrors =
        stats.a.seedErrorCount?.[stats.a.currentSeedId!] ?? 0;
      const forceClose =
        autoDisabled || runtimeErrors >= MAX_ERRORS_PER_SEED_RUN;

      if (
        forceClose ||
        stats.a.pagesDone >= cfg.maxPagesPerSeed ||
        stats.a.pagesDone >= 1
      ) {
        stats.a.doneSeedIds.push(stats.a.currentSeedId!);
        stats.seedsProcessed++;
        stats.a.currentSeedId = null;
        stats.a.seedPlatform = null;
        if (forceClose && !seedErrored) {
          // safety net hit on a seed that never errored — defensive,
          // shouldn't happen but log if it does so we can investigate.
          console.warn(
            `[SCRAPER] Force-closed seed #${seed.id} without explicit error`
          );
        }
      }
    }
    stats.phase = "b";
  }

  // --- Phase B (random-username probes) ------------------------------
  // MVP stub. Left noop until a generic user-info-by-username helper
  // exists for method B; Phase A with relaxed thresholds already gives
  // us a working pool.
  //
  // Global toggle: if cfg.methodBEnabled is false we skip Phase B
  // entirely and flag the run so the UI can tell operators why the
  // phase produced nothing. Note that Phase A ran according to
  // methodARatio as usual — the toggle is additive, not a full
  // scraper pause (for that, use SystemToggle.poolScrapeEnabled).
  if (stats.phase === "b") {
    if (!cfg.methodBEnabled) {
      stats.phaseBSkipped = true;
    }
    // noop body — real Phase B implementation will branch on
    // cfg.methodBEnabled before doing any work.
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

    // Deep fetch for counts via the oracle (RapidAPI /userinfo by
    // user_id). Using the stable id dodges the race where a user
    // renames between /followers (T0) and /userinfo (T1) and the
    // username lookup 404s.
    const oracle = await fetchIgOracle(f.id);
    stats.callsUsed++;

    if (!oracle.ok) {
      if (oracle.reason === "ghost") {
        stats.candidatesRejected.ghost++;
      } else {
        stats.candidatesRejected.fetch_info_failed++;
        stats.errors.push(
          `oracle @${f.username}/${f.id}: ${oracle.message.slice(0, 120)}`
        );
      }
      continue;
    }

    if (cfg.requireNotPrivate && oracle.isPrivate) {
      stats.candidatesRejected.private++;
      continue;
    }
    if (oracle.followerCount > cfg.maxFollowerCount) {
      stats.candidatesRejected.too_many_followers++;
      continue;
    }
    if (oracle.mediaCount > cfg.maxMediaCount) {
      stats.candidatesRejected.too_much_media++;
      continue;
    }
    if (oracle.followingCount > cfg.maxFollowingCount) {
      stats.candidatesRejected.too_many_following++;
      continue;
    }

    // Qualified — upsert with the oracle's CURRENT username (stable
    // user_id is the dedup key in spirit, but Prisma's unique index is
    // [platform, username] so we write the oracle username there).
    const storedUsername = oracle.username || f.username;
    const res = await prisma.testAccount.upsert({
      where: { platform_username: { platform: "instagram", username: storedUsername } },
      update: {},
      create: {
        platform: "instagram",
        username: storedUsername,
        userId: oracle.userId,
        status: "available",
        lastFollowerCount: oracle.followerCount,
        lastMediaCount: oracle.mediaCount,
        lastFollowingCount: oracle.followingCount,
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
    maxFollowerCountTiktok: number;
    maxMediaCount: number;
    maxFollowingCount: number;
  };
}) {
  const info = await fetchTikTokUserByUsername(seed.username);
  stats.callsUsed++;
  const { sample } = await fetchTikTokFollowers(info.userId);
  stats.callsUsed++;

  // TT uses a looser follower threshold than IG because the platform's
  // viral exposure model pushes dormant accounts to 5-30 followers
  // organically; a 5-cap there would reject healthy test candidates.
  const ttFollowerCap = cfg.maxFollowerCountTiktok;

  for (const f of sample) {
    stats.candidatesFetched++;

    // Cheap prefilter from the /followers payload (no extra call).
    if (f.follower_count > ttFollowerCap) {
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

    // Cross-validate via oracle by user_id — catches "ghost" cases
    // where the follower object is stale (account deleted/banned
    // between the /followers snapshot and now).
    const oracle = await fetchTtOracle(f.id);
    stats.callsUsed++;
    if (!oracle.ok) {
      if (oracle.reason === "ghost") stats.candidatesRejected.ghost++;
      else {
        stats.candidatesRejected.fetch_info_failed++;
        stats.errors.push(
          `oracle @${f.unique_id}/${f.id}: ${oracle.message.slice(0, 120)}`
        );
      }
      continue;
    }

    // Re-qualify with the fresh oracle counts (they may differ from
    // the /followers snapshot).
    if (oracle.followerCount > ttFollowerCap) {
      stats.candidatesRejected.too_many_followers++;
      continue;
    }
    if (oracle.mediaCount > cfg.maxMediaCount) {
      stats.candidatesRejected.too_much_media++;
      continue;
    }
    if (oracle.followingCount > cfg.maxFollowingCount) {
      stats.candidatesRejected.too_many_following++;
      continue;
    }

    const storedUsername = oracle.username || f.unique_id;
    const res = await prisma.testAccount.upsert({
      where: {
        platform_username: {
          platform: "tiktok",
          username: storedUsername,
        },
      },
      update: {},
      create: {
        platform: "tiktok",
        username: storedUsername,
        userId: oracle.userId,
        status: "available",
        lastFollowerCount: oracle.followerCount,
        lastMediaCount: oracle.mediaCount,
        lastFollowingCount: oracle.followingCount,
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
