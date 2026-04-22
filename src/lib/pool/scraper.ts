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
import { fetchIgOracle, fetchTtOracle, type OracleResult } from "./oracle";
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
// RapidAPI plan is far roomier than IG's. Bumping IG above 4-5 hits
// 429s; TT happily takes 8-way parallelism.
const IG_ORACLE_CONCURRENCY = 4;
const TT_ORACLE_CONCURRENCY = 8;
const TT_MULTI_SEED_CONCURRENCY = 3;

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
  if (oracle.followerCount > cfg.maxFollowerCount) {
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

  // Phase 1 — pre-filter on /followers payload (already has follower_
  // count, following_count, aweme_count, so this catches most rejects
  // without any oracle call) + dedup.
  const survivors: typeof sample = [];
  for (const f of sample) {
    stats.candidatesFetched++;

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
    ctx.existingKeys.add(`tiktok:user:${storedUsername.toLowerCase()}`);
    ctx.existingKeys.add(`tiktok:uid:${oracle.userId}`);
  }
}
