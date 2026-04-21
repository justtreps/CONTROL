// Daily health check for PoolSeedAccount entries.
//
// For each enabled seed we resolve its stable userId (if not stored
// yet) and call the oracle. Three outcomes:
//
//   1. ghost / 404  → seed is dead. Delete it. Pick a replacement
//      from the PoolSeedSuggestionPool cache (same platform) and
//      promote it to an enabled seed. If the cache is empty, log
//      "cache_empty_refill_triggered" and fire-and-forget a refill.
//
//   2. username changed (oracle returned a different handle for the
//      same userId)  → update seed.username in place so /pool seeds
//      UI + scraper stay addressable.
//
//   3. ok  → bump lastCheckedAt (and persist userId if we just
//      resolved it).
//
// Runs from:
//   • /api/cron/pool-seeds-health-check   (Vercel cron, CRON_SECRET)
//   • /api/pool/seeds-health-check-manual (session auth, on-demand
//     button in the /pool UI)
//
// Both paths share this module so the logic stays single-sourced.

import { prisma } from "@/lib/prisma";
import { fetchIgOracle, fetchTtOracle, type OracleResult } from "./oracle";
import { fetchTikTokUserByUsername } from "@/lib/rapidapi/tiktok";
import { refillSuggestionPool } from "./suggestion-pool";

type PlatformBuckets = Record<
  "instagram" | "tiktok",
  {
    checked: number;
    dead: number;
    replaced: number;
    renamed: number;
    ok: number;
  }
>;

export type SeedsHealthStats = {
  byPlatform: PlatformBuckets;
  totalChecked: number;
  totalDead: number;
  totalReplaced: number;
  totalRenamed: number;
  totalOk: number;
  cacheEmptyHits: number;
  callsUsed: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

function emptyBuckets(): PlatformBuckets {
  return {
    instagram: { checked: 0, dead: 0, replaced: 0, renamed: 0, ok: 0 },
    tiktok: { checked: 0, dead: 0, replaced: 0, renamed: 0, ok: 0 },
  };
}

export async function runSeedsHealthCheck(): Promise<SeedsHealthStats> {
  const startedAt = new Date();
  const byPlatform = emptyBuckets();
  let callsUsed = 0;
  let cacheEmptyHits = 0;
  const errors: string[] = [];

  const seeds = await prisma.poolSeedAccount.findMany({
    where: { enabled: true },
    orderBy: [{ platform: "asc" }, { priority: "desc" }, { id: "asc" }],
  });

  // Process N seeds in parallel. With ~66 enabled seeds and ~1-2s per
  // RapidAPI call, serial execution blows past the 60s function budget.
  // Concurrency of 8 keeps us well under the maxDuration while staying
  // nice to RapidAPI (provider rate limits kick in much higher).
  const CONCURRENCY = 8;
  for (let i = 0; i < seeds.length; i += CONCURRENCY) {
    const batch = seeds.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (seed) => {
        if (seed.platform !== "instagram" && seed.platform !== "tiktok") {
          errors.push(`seed #${seed.id}: unsupported platform ${seed.platform}`);
          return;
        }
        const platform = seed.platform as "instagram" | "tiktok";

        try {
          const res = await checkOneSeed(seed);
          callsUsed += res.callsUsed;

          switch (res.outcome) {
            case "ok":
              byPlatform[platform].ok++;
              byPlatform[platform].checked++;
              break;
            case "renamed":
              byPlatform[platform].renamed++;
              byPlatform[platform].checked++;
              break;
            case "dead": {
              byPlatform[platform].dead++;
              byPlatform[platform].checked++;
              const replacement = await pickReplacementFromCache(platform);
              if (replacement) {
                byPlatform[platform].replaced++;
              } else {
                cacheEmptyHits++;
              }
              break;
            }
            case "error":
              errors.push(
                `seed #${seed.id} (@${seed.username}): ${res.message}`
              );
              break;
          }
        } catch (e) {
          errors.push(
            `seed #${seed.id} (@${seed.username}): ${(e as Error).message.slice(0, 200)}`
          );
        }
      })
    );
  }

  const finishedAt = new Date();
  const totalChecked =
    byPlatform.instagram.checked + byPlatform.tiktok.checked;
  const totalDead = byPlatform.instagram.dead + byPlatform.tiktok.dead;
  const totalReplaced =
    byPlatform.instagram.replaced + byPlatform.tiktok.replaced;
  const totalRenamed =
    byPlatform.instagram.renamed + byPlatform.tiktok.renamed;
  const totalOk = byPlatform.instagram.ok + byPlatform.tiktok.ok;

  console.log(
    `[SEEDS_HEALTH] IG: ${byPlatform.instagram.checked} checked, ${byPlatform.instagram.dead} dead (${byPlatform.instagram.replaced} replaced), ${byPlatform.instagram.renamed} renamed, ${byPlatform.instagram.ok} ok · ` +
      `TT: ${byPlatform.tiktok.checked} checked, ${byPlatform.tiktok.dead} dead (${byPlatform.tiktok.replaced} replaced), ${byPlatform.tiktok.renamed} renamed, ${byPlatform.tiktok.ok} ok · ` +
      `calls=${callsUsed} cacheEmpty=${cacheEmptyHits}`
  );

  return {
    byPlatform,
    totalChecked,
    totalDead,
    totalReplaced,
    totalRenamed,
    totalOk,
    cacheEmptyHits,
    callsUsed,
    errors,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

// ── Single seed ──────────────────────────────────────────────────────
type SeedCheckOutcome =
  | { outcome: "ok"; callsUsed: number }
  | { outcome: "renamed"; callsUsed: number; oldUsername: string; newUsername: string }
  | { outcome: "dead"; callsUsed: number; reason: string }
  | { outcome: "error"; callsUsed: number; message: string };

async function checkOneSeed(seed: {
  id: number;
  platform: string;
  username: string;
  userId: string | null;
}): Promise<SeedCheckOutcome> {
  const platform = seed.platform as "instagram" | "tiktok";

  // 1. Resolve userId if missing (both branches return inside the if).
  let callsUsed = 0;

  if (!seed.userId) {
    if (platform === "instagram") {
      // IG oracle helper accepts either username or id, so one call
      // does both resolution + liveness.
      const oracle = await fetchIgOracle(seed.username);
      callsUsed++;
      return persistOracleResult(seed, oracle, callsUsed);
    } else {
      // TT: fetchTikTokUserByUsername already returns the full user
      // info (userId + current unique_id + counts), so it doubles as
      // the oracle call — no need for a second fetchTtOracle trip.
      try {
        const info = await fetchTikTokUserByUsername(seed.username);
        callsUsed++;
        if (!info?.userId) {
          await markDead(seed, "tt: user_by_username returned no userId");
          return {
            outcome: "dead",
            callsUsed,
            reason: "tt: user_by_username not found",
          };
        }
        return persistOracleResult(
          seed,
          {
            ok: true,
            platform: "tiktok",
            userId: info.userId,
            username: info.uniqueId,
            followerCount: info.followerCount,
            followingCount: info.followingCount,
            mediaCount: info.mediaCount,
            isPrivate: false,
          },
          callsUsed
        );
      } catch (e) {
        const msg = (e as Error).message;
        // Treat TT provider errors that mean "this username doesn't
        // resolve to a live account" as ghost. Covers:
        //   • /404/                       - classic HTTP miss
        //   • /not found/                 - legacy wording
        //   • /unique_id is invalid/      - TT returns this for a
        //                                   deleted / banned handle
        //   • /userinfo is failed/        - TT's own "not found" variant
        if (
          /not\s*found/i.test(msg) ||
          /404/.test(msg) ||
          /unique_id\s+is\s+invalid/i.test(msg) ||
          /userinfo\s+is\s+failed/i.test(msg)
        ) {
          await markDead(seed, `tt resolve: ${msg.slice(0, 160)}`);
          return { outcome: "dead", callsUsed, reason: msg.slice(0, 200) };
        }
        await logEntry({
          platform,
          action: "error",
          seedUsername: seed.username,
          reason: `resolve: ${msg.slice(0, 180)}`,
        });
        return {
          outcome: "error",
          callsUsed,
          message: `resolve failed: ${msg.slice(0, 180)}`,
        };
      }
    }
  }

  // 2. Oracle with userId in hand (one call either way).
  const oracle =
    platform === "instagram"
      ? await fetchIgOracle(seed.userId!)
      : await fetchTtOracle(seed.userId!);
  callsUsed++;
  return persistOracleResult(seed, oracle, callsUsed);
}

async function persistOracleResult(
  seed: { id: number; platform: string; username: string; userId: string | null },
  oracle: OracleResult,
  callsUsed: number
): Promise<SeedCheckOutcome> {
  const platform = seed.platform as "instagram" | "tiktok";

  if (!oracle.ok) {
    if (oracle.reason === "ghost") {
      await markDead(seed, oracle.message);
      return { outcome: "dead", callsUsed, reason: oracle.message };
    }
    // Transient error — don't delete the seed, just log and skip.
    await logEntry({
      platform,
      action: "error",
      seedUsername: seed.username,
      reason: oracle.message.slice(0, 180),
    });
    return {
      outcome: "error",
      callsUsed,
      message: oracle.message.slice(0, 180),
    };
  }

  const oracleUsername = oracle.username || seed.username;
  const renamed =
    oracleUsername.length > 0 &&
    oracleUsername.toLowerCase() !== seed.username.toLowerCase();

  if (renamed) {
    // Can collide with an existing row if someone else registered the
    // new handle. Handle gracefully by logging and leaving the old
    // row alone — operator can deduplicate later.
    try {
      await prisma.poolSeedAccount.update({
        where: { id: seed.id },
        data: {
          username: oracleUsername,
          userId: oracle.userId,
          lastCheckedAt: new Date(),
        },
      });
      await logEntry({
        platform,
        action: "renamed",
        seedUsername: seed.username,
        newUsername: oracleUsername,
        reason: `userId=${oracle.userId}`,
      });
      return {
        outcome: "renamed",
        callsUsed,
        oldUsername: seed.username,
        newUsername: oracleUsername,
      };
    } catch (e) {
      const msg = (e as Error).message;
      await logEntry({
        platform,
        action: "error",
        seedUsername: seed.username,
        newUsername: oracleUsername,
        reason: `rename collision: ${msg.slice(0, 150)}`,
      });
      return {
        outcome: "error",
        callsUsed,
        message: `rename collision: ${msg.slice(0, 150)}`,
      };
    }
  }

  // 3. OK path — persist userId (if newly resolved) + bump timestamp.
  await prisma.poolSeedAccount.update({
    where: { id: seed.id },
    data: {
      userId: oracle.userId,
      lastCheckedAt: new Date(),
    },
  });
  return { outcome: "ok", callsUsed };
}

// ── Dead seed handling ──────────────────────────────────────────────
async function markDead(
  seed: { id: number; platform: string; username: string },
  reason: string
): Promise<void> {
  const platform = seed.platform;
  await prisma.poolSeedAccount.delete({ where: { id: seed.id } });
  await logEntry({
    platform,
    action: "deleted_mort",
    seedUsername: seed.username,
    reason: reason.slice(0, 200),
  });
}

async function pickReplacementFromCache(
  platform: "instagram" | "tiktok"
): Promise<{ username: string } | null> {
  // Pick the oldest cached suggestion (FIFO — fresh ones rotate in
  // later). Do the delete + seed insert inside a tx so we never end
  // up with a double-claim under concurrent health-check runs.
  const picked = await prisma.poolSeedSuggestionPool.findFirst({
    where: { platform },
    orderBy: { createdAt: "asc" },
  });

  if (!picked) {
    // Log + kick off a refill. Replacement didn't happen this run —
    // the next daily health-check (or next manual trigger) will pick
    // up from the refilled cache.
    await logEntry({
      platform,
      action: "cache_empty_refill_triggered",
      seedUsername: "",
      reason:
        "no cached suggestion available — background refill triggered",
    });
    void refillSuggestionPool(platform).catch(() => {
      /* fire-and-forget */
    });
    return null;
  }

  try {
    await prisma.$transaction([
      prisma.poolSeedSuggestionPool.delete({ where: { id: picked.id } }),
      prisma.poolSeedAccount.upsert({
        where: {
          platform_username: {
            platform: picked.platform,
            username: picked.username,
          },
        },
        update: { enabled: true, priority: 0 },
        create: {
          platform: picked.platform,
          username: picked.username,
          enabled: true,
          priority: 0,
        },
      }),
    ]);
  } catch (e) {
    // Another concurrent check already claimed this row. Report +
    // let the caller note this as a cache-empty case so we can retry
    // later.
    await logEntry({
      platform,
      action: "error",
      seedUsername: picked.username,
      reason: `replacement upsert failed: ${(e as Error).message.slice(0, 140)}`,
    });
    return null;
  }

  await logEntry({
    platform,
    action: "replaced_from_cache",
    seedUsername: "", // replacement isn't tied to a specific dead seed row in
    //                 this log entry — the dead seed's "deleted_mort" entry
    //                 precedes it and together they narrate the swap.
    newUsername: picked.username,
  });
  return { username: picked.username };
}

// ── Log writer ──────────────────────────────────────────────────────
async function logEntry(data: {
  platform: string;
  action: string;
  seedUsername: string;
  newUsername?: string;
  reason?: string;
}): Promise<void> {
  try {
    await prisma.poolSeedHealthLog.create({ data });
  } catch (e) {
    // Never let log-write failure break the health-check run.
    console.error("[SEEDS_HEALTH] log write failed:", (e as Error).message);
  }
}
