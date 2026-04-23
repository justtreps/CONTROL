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
  fetchInstagramUserPosts,
  instagramPostUrl,
} from "@/lib/rapidapi/instagram";
import {
  fetchTikTokFollowers,
  fetchTikTokUserByUsername,
  fetchTikTokUserVideos,
  tiktokVideoUrl,
} from "@/lib/rapidapi/tiktok";
import { fetchIgOracle, fetchTtOracle, type OracleResult } from "./oracle";
import { getPoolConfig } from "./config";
import { detectAccountCountry } from "./country-detection";

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
  // Universe override — set when the /api/pool/scrape call passed a
  // poolType (from the top-of-page universe switch on /pool). When
  // set, candidate classification is hard-forced:
  //   follower    → only mediaCount == 0 qualifies (rest rejected)
  //   engagement  → only mediaCount >= engagementPostsMin qualifies
  // Legacy jobs (undefined) keep the old engagementPoolEnabled gate.
  poolType?: "follower" | "engagement";
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
      // Skip seeds that have racked up persistent errors across runs —
      // likely broken / banned / locked. AUTO_DISABLE_PRIVATE_THRESHOLD
      // trips them off; this filter is a soft safety net for the few
      // ticks between the N-th error and the auto-disable write.
      consecutiveErrors: { lt: AUTO_DISABLE_PRIVATE_THRESHOLD },
      id: { notIn: excludeIds.length > 0 ? excludeIds : [-1] },
    },
    orderBy: [{ priority: "desc" }, { addedAt: "asc" }],
  });
}

// Same filter as pickNextSeed but returns N seeds — used by the
// multi-seed TT parallelism path (runs 3 TT seeds simultaneously
// since the TT RapidAPI plan has quota headroom).
async function pickNextNSeeds(
  platform: "instagram" | "tiktok",
  n: number,
  excludeIds: number[]
) {
  return prisma.poolSeedAccount.findMany({
    where: {
      platform,
      enabled: true,
      consecutiveErrors: { lt: AUTO_DISABLE_PRIVATE_THRESHOLD },
      id: { notIn: excludeIds.length > 0 ? excludeIds : [-1] },
    },
    orderBy: [{ priority: "desc" }, { addedAt: "asc" }],
    take: n,
  });
}

// ── Tranche-local optimization context ──────────────────────────────
// Built once at the top of runScrapeTranche and passed down so the
// per-seed / per-candidate code can:
//   • `oracleCache`  — skip a second /userinfo call for a userId we
//     already resolved this tranche (e.g. two seeds share a follower)
//   • `existingKeys` — skip oracle entirely for handles already in our
//     TestAccount pool (covers both username renames → userId and
//     fresh duplicates from seed overlap)
//   • `aborted`      — cooperative early-exit: set to true by any
//     worker that tips stats past target, checked by sibling workers
//     between batches so they stop cleanly
export type ScrapeContext = {
  oracleCache: Map<string, OracleResult>;
  existingKeys: Set<string>;
  aborted: { value: boolean };
};

async function buildScrapeContext(
  platforms: Array<"instagram" | "tiktok">
): Promise<ScrapeContext> {
  const rows = await prisma.testAccount.findMany({
    where: { platform: { in: platforms } },
    select: { platform: true, username: true, userId: true },
  });
  const existingKeys = new Set<string>();
  for (const r of rows) {
    existingKeys.add(`${r.platform}:user:${r.username.toLowerCase()}`);
    if (r.userId) existingKeys.add(`${r.platform}:uid:${r.userId}`);
  }
  return {
    oracleCache: new Map(),
    existingKeys,
    aborted: { value: false },
  };
}

// Concurrency tuning — different caps per platform because the TT
// RapidAPI plan is far roomier than IG's. IG ULTRA still 429s above
// 3-way parallelism on sustained load (measured empirically after
// the budget bump to 10k calls/run); TT happily takes 8.
const IG_ORACLE_CONCURRENCY = 3;
const TT_ORACLE_CONCURRENCY = 8;
const TT_MULTI_SEED_CONCURRENCY = 3;

// Shape of a post we can hand BulkMedya for engagement tests. Built
// from either fetchInstagramUserPosts() or fetchTikTokUserVideos()
// and filtered by freshness + natural likes against PoolConfig before
// being written to TestAccountMedia.
type EngagementPost = {
  mediaId: string;
  mediaUrl: string;
  mediaType: "post" | "reel" | "video";
  likeCount: number;
  postedAt: Date | null;
};

// Fetch + filter an engagement candidate's recent posts. Returns an
// empty array when the provider call fails OR the account has no
// post matching the freshness + likes ceiling — the caller treats
// this as "reject: no_valid_posts" and doesn't insert the account.
//
// Uses stats.callsUsed for budget accounting and stats.errors for
// any transient provider error (so we can see why a given seed's
// engagement yield tanked).
async function fetchValidEngagementPosts({
  platform,
  userId,
  stats,
  cfg,
}: {
  platform: "instagram" | "tiktok";
  userId: string;
  stats: ScrapeStats;
  cfg: Awaited<ReturnType<typeof getPoolConfig>>;
}): Promise<EngagementPost[]> {
  const maxAgeMs =
    (cfg.engagementFreshnessMaxDays ?? 90) * 24 * 3600 * 1000;
  const nowMs = Date.now();
  const maxLikes = cfg.engagementLikesMaxPerPost ?? 20;

  try {
    if (platform === "instagram") {
      const { posts } = await fetchInstagramUserPosts(userId, 5);
      stats.callsUsed++;
      const valid: EngagementPost[] = [];
      for (const p of posts) {
        if (p.likeCount > maxLikes) continue;
        if (p.takenAt !== null && nowMs - p.takenAt > maxAgeMs) continue;
        valid.push({
          mediaId: p.mediaId,
          mediaUrl: instagramPostUrl(p),
          mediaType: p.mediaType,
          likeCount: p.likeCount,
          postedAt: p.takenAt ? new Date(p.takenAt) : null,
        });
      }
      return valid;
    }
    const { videos } = await fetchTikTokUserVideos(userId, 5);
    stats.callsUsed++;
    const valid: EngagementPost[] = [];
    for (const v of videos) {
      if (v.likeCount > maxLikes) continue;
      if (v.createTime !== null && nowMs - v.createTime > maxAgeMs) continue;
      valid.push({
        mediaId: v.mediaId,
        mediaUrl: tiktokVideoUrl(v),
        mediaType: "video",
        likeCount: v.likeCount,
        postedAt: v.createTime ? new Date(v.createTime) : null,
      });
    }
    return valid;
  } catch (e) {
    stats.errors.push(
      `engagement-posts ${platform}/${userId}: ${(e as Error).message.slice(0, 120)}`
    );
    return [];
  }
}

// Per-seed lifecycle: run the processor inside try/catch, track
// errors at both job and DB level, auto-disable on persistent
// private-account signals. Extracted so the main loop can call it
// sequentially (IG) or in Promise.all (TT multi-seed).
async function runSeedSafely({
  seed,
  stats,
  cfg,
  ctx,
}: {
  seed: {
    id: number;
    username: string;
    platform: string;
    consecutiveErrors: number | null;
  };
  stats: ScrapeStats;
  cfg: Awaited<ReturnType<typeof getPoolConfig>>;
  ctx: ScrapeContext;
}): Promise<void> {
  try {
    if (seed.platform === "instagram") {
      await processInstagramSeed({ seed, stats, cfg, ctx });
    } else if (seed.platform === "tiktok") {
      await processTikTokSeed({ seed, stats, cfg, ctx });
    }
    if ((seed.consecutiveErrors ?? 0) > 0) {
      await prisma.poolSeedAccount.update({
        where: { id: seed.id },
        data: { consecutiveErrors: 0, lastErrorReason: null },
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    stats.errors.push(
      `seed ${seed.username}/${seed.platform}: ${msg.slice(0, 160)}`
    );
    if (!stats.a.seedErrorCount) stats.a.seedErrorCount = {};
    stats.a.seedErrorCount[seed.id] =
      (stats.a.seedErrorCount[seed.id] ?? 0) + 1;

    const newStreak = (seed.consecutiveErrors ?? 0) + 1;
    const privateSignal = isPrivateLikeError(msg);
    if (privateSignal && newStreak >= AUTO_DISABLE_PRIVATE_THRESHOLD) {
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

  const ctx = await buildScrapeContext(platformsToRun);
  const wantA = Math.max(1, Math.round(stats.target * cfg.methodARatio));
  const totalAdded = () => stats.addedA + stats.addedB;

  // Shared early-exit check so every yield point evaluates the same
  // termination conditions without duplication.
  const shouldStop = async (): Promise<boolean> => {
    if (ctx.aborted.value) return true;
    if (Date.now() > deadline) return true;
    if (await stopRequested()) return true;
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) return true;
    if (totalAdded() >= wantA) {
      ctx.aborted.value = true;
      return true;
    }
    return false;
  };

  // --- Phase A ---------------------------------------------------------
  if (stats.phase === "a") {
    while (totalAdded() < wantA) {
      if (await shouldStop()) return { done: false, stats };

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

      // --- TT multi-seed parallelism --------------------------------
      // TT's follower API is fast and its RapidAPI plan has room, so
      // process TT_MULTI_SEED_CONCURRENCY seeds simultaneously.
      // IG stays single-seed-at-a-time (quota-constrained).
      if (seed.platform === "tiktok") {
        const extras = await pickNextNSeeds(
          "tiktok",
          TT_MULTI_SEED_CONCURRENCY - 1,
          [...stats.a.doneSeedIds, seed.id]
        );
        const batch = [seed, ...extras];
        await Promise.all(
          batch.map((s) => runSeedSafely({ seed: s, stats, cfg, ctx }))
        );
        for (const s of batch) {
          stats.a.doneSeedIds.push(s.id);
          stats.seedsProcessed++;
        }
        stats.a.currentSeedId = null;
        stats.a.seedPlatform = null;
        continue;
      }

      // --- IG single-seed (with internal candidate concurrency) -----
      await runSeedSafely({ seed, stats, cfg, ctx });

      const runtimeErrors =
        stats.a.seedErrorCount?.[stats.a.currentSeedId!] ?? 0;
      const forceClose = runtimeErrors >= MAX_ERRORS_PER_SEED_RUN;

      if (
        forceClose ||
        stats.a.pagesDone >= cfg.maxPagesPerSeed ||
        stats.a.pagesDone >= 1
      ) {
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
  ctx,
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
  ctx: ScrapeContext;
}) {
  const { sample } = await fetchInstagramFollowers(seed.username);
  stats.callsUsed++;

  // Phase 1 — cheap pre-filter using only the follower payload.
  // No API calls, pure sync checks: is_verified / is_private / dedup
  // against the TestAccount snapshot. Reduces oracle calls ~40% on
  // typical seeds where ~half the sample is already known or flagged.
  const survivors: typeof sample = [];
  for (const f of sample) {
    stats.candidatesFetched++;

    if (f.is_verified) {
      stats.candidatesRejected.verified++;
      continue;
    }
    if (cfg.requireNotPrivate && f.is_private) {
      stats.candidatesRejected.private++;
      continue;
    }
    const userKey = `instagram:user:${f.username.toLowerCase()}`;
    const idKey = `instagram:uid:${f.id}`;
    if (ctx.existingKeys.has(userKey) || ctx.existingKeys.has(idKey)) {
      stats.candidatesRejected.other++;
      continue;
    }
    survivors.push(f);
  }

  // Phase 2 — parallel oracle validation on survivors. Each batch of
  // IG_ORACLE_CONCURRENCY runs its /userinfo calls concurrently. Between
  // batches we re-check the shared abort/budget flags so early-exit
  // propagates without waiting for the whole sample to complete.
  for (let i = 0; i < survivors.length; i += IG_ORACLE_CONCURRENCY) {
    if (ctx.aborted.value) break;
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) break;
    const batch = survivors.slice(i, i + IG_ORACLE_CONCURRENCY);
    await Promise.all(
      batch.map((f) => validateAndUpsertIgCandidate({ f, seed, stats, cfg, ctx }))
    );
  }

  stats.a.pagesDone++;
}

async function validateAndUpsertIgCandidate({
  f,
  seed,
  stats,
  cfg,
  ctx,
}: {
  f: Awaited<ReturnType<typeof fetchInstagramFollowers>>["sample"][number];
  seed: { id: number; username: string };
  stats: ScrapeStats;
  cfg: {
    requireNotPrivate: boolean;
    maxFollowerCount: number;
    maxMediaCount: number;
    maxFollowingCount: number;
    maxRapidapiCallsPerScrapeRun: number;
  };
  ctx: ScrapeContext;
}): Promise<void> {
  if (ctx.aborted.value) return;
  if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) {
    stats.candidatesRejected.other++;
    return;
  }

  // Oracle cache — same userId from a different seed in the same
  // tranche skips the second RapidAPI call entirely.
  const cacheKey = `instagram:${f.id}`;
  let oracle = ctx.oracleCache.get(cacheKey);
  if (!oracle) {
    try {
      oracle = await fetchIgOracle(f.id);
    } catch (e) {
      oracle = {
        ok: false,
        reason: "error",
        message: (e as Error).message.slice(0, 200),
      };
    }
    stats.callsUsed++;
    ctx.oracleCache.set(cacheKey, oracle);
  }

  if (!oracle.ok) {
    if (oracle.reason === "ghost") {
      stats.candidatesRejected.ghost++;
    } else {
      stats.candidatesRejected.fetch_info_failed++;
      stats.errors.push(
        `oracle @${f.username}/${f.id}: ${oracle.message.slice(0, 120)}`
      );
    }
    return;
  }

  if (cfg.requireNotPrivate && oracle.isPrivate) {
    stats.candidatesRejected.private++;
    return;
  }
  // Engagement scrapes don't care about the parent account's follower
  // count — what matters is each post's natural-likes baseline +
  // freshness. A 100k-follower account with a stale low-likes post
  // still qualifies; its posts get evaluated individually below.
  const isEngagementScrape = stats.poolType === "engagement";
  if (!isEngagementScrape && oracle.followerCount > cfg.maxFollowerCount) {
    stats.candidatesRejected.too_many_followers++;
    return;
  }
  if (oracle.mediaCount > cfg.maxMediaCount) {
    stats.candidatesRejected.too_much_media++;
    return;
  }
  if (oracle.followingCount > cfg.maxFollowingCount) {
    stats.candidatesRejected.too_many_following++;
    return;
  }

  // Account-type routing. Two modes:
  //
  // (A) Universe-scoped job (stats.poolType set — triggered from the
  //     /pool ABONNÉS / ENGAGEMENT switch): hard-force accountType
  //     and REJECT candidates that don't fit. This way a scrape
  //     launched from "POOL ENGAGEMENT" never adds zero-post rows
  //     that would just bloat the follower universe.
  //
  // (B) Legacy job (no poolType): fall back to the engagementPool
  //     Enabled gate — mediaCount == 0 stays follower_test, >= min
  //     becomes engagement_test when the toggle is on, everything
  //     else falls through as follower_test.
  const engagementCfg = cfg as unknown as {
    engagementPoolEnabled?: boolean;
    engagementPostsMin?: number;
  };
  const minP = engagementCfg.engagementPostsMin ?? 1;
  let accountType: "follower_test" | "engagement_test" = "follower_test";
  if (stats.poolType === "follower") {
    if (oracle.mediaCount > 0) {
      stats.candidatesRejected.other++;
      return;
    }
  } else if (stats.poolType === "engagement") {
    if (oracle.mediaCount < minP) {
      stats.candidatesRejected.other++;
      return;
    }
    accountType = "engagement_test";
  } else if (engagementCfg.engagementPoolEnabled && oracle.mediaCount > 0) {
    if (oracle.mediaCount >= minP) {
      accountType = "engagement_test";
    }
    // else (mediaCount in [1, minP-1]) falls through as follower_test
  }

  // Country detection — cheap, runs on sample data. fullName from the
  // follower payload + username are enough to hit most tiers; bio is
  // only in the oracle response for IG (not stored here, so skip).
  const country = detectAccountCountry({
    fullName: f.full_name ?? null,
    username: oracle.username || f.username,
  });

  const storedUsername = oracle.username || f.username;

  // Engagement candidate → we need at least one valid post before we
  // commit to persisting the row. Otherwise the pool would fill up
  // with accounts the testbot can't use.
  let validPosts: EngagementPost[] = [];
  if (accountType === "engagement_test") {
    validPosts = await fetchValidEngagementPosts({
      platform: "instagram",
      userId: oracle.userId,
      stats,
      cfg: cfg as Awaited<ReturnType<typeof getPoolConfig>>,
    });
    if (validPosts.length === 0) {
      stats.candidatesRejected.other++;
      return;
    }
  }

  // Insert the parent account + its engagement posts atomically. Under
  // the new model an account is purely a metadata carrier for the
  // posts — the lifecycle (available/assigned/consumed/invalid) lives
  // on TestPost. A single account can contribute N rows, so one scrape
  // iteration may produce multiple pool entries.
  const res = await prisma.$transaction(async (tx) => {
    const account = await tx.testAccount.upsert({
      where: {
        platform_username: { platform: "instagram", username: storedUsername },
      },
      update: {},
      create: {
        platform: "instagram",
        username: storedUsername,
        userId: oracle.userId,
        status: "available",
        accountType,
        detectedCountry: country.country,
        countryConfidence: country.confidence,
        lastFollowerCount: oracle.followerCount,
        lastMediaCount: oracle.mediaCount,
        lastFollowingCount: oracle.followingCount,
        // Oracle just ran — lastMediaCount is fresh, mark the account
        // eligible for the phase-1 engagement extract without a
        // second RapidAPI roundtrip.
        hasPostsInfo: true,
        scrapeSource: "big_account_followers",
        scrapeSeedAccount: seed.username,
      },
    });
    let insertedPosts = 0;
    if (
      accountType === "engagement_test" &&
      account.firstSeenAt.getTime() > Date.now() - 2000
    ) {
      const created = await tx.testPost.createMany({
        data: validPosts.map((p) => ({
          testAccountId: account.id,
          platform: "instagram",
          mediaId: p.mediaId,
          mediaUrl: p.mediaUrl,
          mediaType: p.mediaType,
          postedAt: p.postedAt,
          naturalLikesCount: p.likeCount,
          status: "available",
          scrapeSource: "seeds",
        })),
        skipDuplicates: true,
      });
      insertedPosts = created.count;
    }
    return { account, insertedPosts };
  });

  if (res.account.firstSeenAt.getTime() > Date.now() - 2000) {
    // Count per pool entity: one follower account OR N engagement
    // posts. Matches the job target (scrapes launched from the
    // ENGAGEMENT switch ask for N posts, not accounts).
    if (accountType === "engagement_test") {
      stats.addedA += res.insertedPosts;
      if (res.insertedPosts > 0) stats.candidatesQualified++;
    } else {
      stats.addedA++;
      stats.candidatesQualified++;
    }
    ctx.existingKeys.add(`instagram:user:${storedUsername.toLowerCase()}`);
    ctx.existingKeys.add(`instagram:uid:${oracle.userId}`);
  }
}

// ---------- TikTok branch -------------------------------------------------
// TT follower API already returns follower/following/media counts per
// follower, so we get everything from a single `/user/followers` call
// per seed (plus 1 call to resolve the seed's numeric user_id).

async function processTikTokSeed({
  seed,
  stats,
  cfg,
  ctx,
}: {
  seed: { id: number; username: string; platform: string };
  stats: ScrapeStats;
  cfg: {
    maxFollowerCountTiktok: number;
    maxMediaCount: number;
    maxFollowingCount: number;
    maxRapidapiCallsPerScrapeRun: number;
  };
  ctx: ScrapeContext;
}) {
  const info = await fetchTikTokUserByUsername(seed.username);
  stats.callsUsed++;
  const { sample } = await fetchTikTokFollowers(info.userId);
  stats.callsUsed++;

  const ttFollowerCap = cfg.maxFollowerCountTiktok;
  // Engagement scrapes: skip follower-count gate (see IG branch
  // reasoning — the post's natural likes is what matters).
  const isEngagementScrape = stats.poolType === "engagement";

  // Phase 1 — pre-filter on /followers payload (already has follower_
  // count, following_count, aweme_count, so this catches most rejects
  // without any oracle call) + dedup.
  const survivors: typeof sample = [];
  for (const f of sample) {
    stats.candidatesFetched++;

    if (!isEngagementScrape && f.follower_count > ttFollowerCap) {
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
    const userKey = `tiktok:user:${f.unique_id.toLowerCase()}`;
    const idKey = `tiktok:uid:${f.id}`;
    if (ctx.existingKeys.has(userKey) || ctx.existingKeys.has(idKey)) {
      stats.candidatesRejected.other++;
      continue;
    }
    survivors.push(f);
  }

  // Phase 2 — parallel oracle validation (TT quota is roomy enough
  // for TT_ORACLE_CONCURRENCY=8). Same cross-batch early-exit pattern
  // as the IG path.
  for (let i = 0; i < survivors.length; i += TT_ORACLE_CONCURRENCY) {
    if (ctx.aborted.value) break;
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) break;
    const batch = survivors.slice(i, i + TT_ORACLE_CONCURRENCY);
    await Promise.all(
      batch.map((f) =>
        validateAndUpsertTtCandidate({ f, seed, stats, cfg, ctx })
      )
    );
  }

  stats.a.pagesDone++;
}

async function validateAndUpsertTtCandidate({
  f,
  seed,
  stats,
  cfg,
  ctx,
}: {
  f: Awaited<ReturnType<typeof fetchTikTokFollowers>>["sample"][number];
  seed: { id: number; username: string };
  stats: ScrapeStats;
  cfg: {
    maxFollowerCountTiktok: number;
    maxMediaCount: number;
    maxFollowingCount: number;
    maxRapidapiCallsPerScrapeRun: number;
  };
  ctx: ScrapeContext;
}): Promise<void> {
  if (ctx.aborted.value) return;
  if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun) {
    stats.candidatesRejected.other++;
    return;
  }

  const cacheKey = `tiktok:${f.id}`;
  let oracle = ctx.oracleCache.get(cacheKey);
  if (!oracle) {
    try {
      oracle = await fetchTtOracle(f.id);
    } catch (e) {
      oracle = {
        ok: false,
        reason: "error",
        message: (e as Error).message.slice(0, 200),
      };
    }
    stats.callsUsed++;
    ctx.oracleCache.set(cacheKey, oracle);
  }

  if (!oracle.ok) {
    if (oracle.reason === "ghost") stats.candidatesRejected.ghost++;
    else {
      stats.candidatesRejected.fetch_info_failed++;
      stats.errors.push(
        `oracle @${f.unique_id}/${f.id}: ${oracle.message.slice(0, 120)}`
      );
    }
    return;
  }

  const ttFollowerCap = cfg.maxFollowerCountTiktok;
  if (oracle.followerCount > ttFollowerCap) {
    stats.candidatesRejected.too_many_followers++;
    return;
  }
  if (oracle.mediaCount > cfg.maxMediaCount) {
    stats.candidatesRejected.too_much_media++;
    return;
  }
  if (oracle.followingCount > cfg.maxFollowingCount) {
    stats.candidatesRejected.too_many_following++;
    return;
  }

  // Account-type routing (see IG path for reasoning — same mode A/B
  // logic based on stats.poolType vs legacy engagementPoolEnabled).
  const engagementCfg = cfg as unknown as {
    engagementPoolEnabled?: boolean;
    engagementPostsMin?: number;
  };
  const minP = engagementCfg.engagementPostsMin ?? 1;
  let accountType: "follower_test" | "engagement_test" = "follower_test";
  if (stats.poolType === "follower") {
    if (oracle.mediaCount > 0) {
      stats.candidatesRejected.other++;
      return;
    }
  } else if (stats.poolType === "engagement") {
    if (oracle.mediaCount < minP) {
      stats.candidatesRejected.other++;
      return;
    }
    accountType = "engagement_test";
  } else if (engagementCfg.engagementPoolEnabled && oracle.mediaCount > 0) {
    if (oracle.mediaCount >= minP) {
      accountType = "engagement_test";
    }
  }

  // Country detection: nickname (TT's full name equivalent) +
  // signature (bio) + username all feed the detector.
  const country = detectAccountCountry({
    fullName: f.nickname ?? null,
    biography: f.signature ?? null,
    username: oracle.username || f.unique_id,
  });

  const storedUsername = oracle.username || f.unique_id;

  let validPosts: EngagementPost[] = [];
  if (accountType === "engagement_test") {
    validPosts = await fetchValidEngagementPosts({
      platform: "tiktok",
      userId: oracle.userId,
      stats,
      cfg: cfg as Awaited<ReturnType<typeof getPoolConfig>>,
    });
    if (validPosts.length === 0) {
      stats.candidatesRejected.other++;
      return;
    }
  }

  const res = await prisma.$transaction(async (tx) => {
    const account = await tx.testAccount.upsert({
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
        accountType,
        detectedCountry: country.country,
        countryConfidence: country.confidence,
        lastFollowerCount: oracle.followerCount,
        lastMediaCount: oracle.mediaCount,
        lastFollowingCount: oracle.followingCount,
        // Oracle ran — phase-1 extract can skip the re-fetch.
        hasPostsInfo: true,
        scrapeSource: "big_account_followers",
        scrapeSeedAccount: seed.username,
      },
    });
    let insertedPosts = 0;
    if (
      accountType === "engagement_test" &&
      account.firstSeenAt.getTime() > Date.now() - 2000
    ) {
      const created = await tx.testPost.createMany({
        data: validPosts.map((p) => ({
          testAccountId: account.id,
          platform: "tiktok",
          mediaId: p.mediaId,
          mediaUrl: p.mediaUrl,
          mediaType: p.mediaType,
          postedAt: p.postedAt,
          naturalLikesCount: p.likeCount,
          status: "available",
          scrapeSource: "seeds",
        })),
        skipDuplicates: true,
      });
      insertedPosts = created.count;
    }
    return { account, insertedPosts };
  });

  if (res.account.firstSeenAt.getTime() > Date.now() - 2000) {
    if (accountType === "engagement_test") {
      stats.addedA += res.insertedPosts;
      if (res.insertedPosts > 0) stats.candidatesQualified++;
    } else {
      stats.addedA++;
      stats.candidatesQualified++;
    }
    ctx.existingKeys.add(`tiktok:user:${storedUsername.toLowerCase()}`);
    ctx.existingKeys.add(`tiktok:uid:${oracle.userId}`);
  }
}
