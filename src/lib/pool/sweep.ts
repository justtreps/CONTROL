// One-shot sweep: walks every 'available' account on a platform and
// reconciles it against the oracle (lib/pool/oracle.ts).
//
// Outcomes:
//   deleted         → oracle 'ghost' → status='invalid' reason='deleted'
//   renamed         → oracle username differs → UPDATE username
//   became_active   → counts exceed PoolConfig thresholds
//   became_private  → IG is_private=true and requireNotPrivate
//   ok              → still within thresholds; counts refreshed
//   error           → transient oracle failure; lastCheckedAt touched
//
// Works for BOTH instagram and tiktok via the same oracle abstraction.

import { prisma } from "@/lib/prisma";
import { fetchOracleFor } from "./oracle";
import { getPoolConfig } from "./config";

export type SweepOutcome =
  | "deleted"
  | "renamed"
  | "became_active"
  | "became_private"
  | "ok"
  | "error";

export type SweepStats = {
  platform: "instagram" | "tiktok";
  total: number;
  processed: number;
  byOutcome: Record<SweepOutcome, number>;
  renamedSamples: Array<{ id: number; from: string; to: string }>;
  deletedSamples: Array<{ id: number; username: string; userId: string }>;
  errorsSample: Array<{ id: number; message: string }>;
  durationMs: number;
};

export async function sweepPool(opts: {
  platform: "instagram" | "tiktok";
  budgetMs?: number;
  limit?: number;
}): Promise<SweepStats> {
  const platform = opts.platform;
  const budgetMs = opts.budgetMs ?? 55_000;
  const limit = opts.limit ?? 500;
  const deadline = Date.now() + budgetMs;
  const startedAt = Date.now();

  const cfg = await getPoolConfig();

  const rows = await prisma.testAccount.findMany({
    where: { platform, status: "available" },
    orderBy: { lastCheckedAt: "asc" },
    take: limit,
    select: {
      id: true,
      username: true,
      userId: true,
    },
  });

  const stats: SweepStats = {
    platform,
    total: rows.length,
    processed: 0,
    byOutcome: {
      deleted: 0,
      renamed: 0,
      became_active: 0,
      became_private: 0,
      ok: 0,
      error: 0,
    },
    renamedSamples: [],
    deletedSamples: [],
    errorsSample: [],
    durationMs: 0,
  };

  for (const r of rows) {
    if (Date.now() > deadline) break;

    const oracle = await fetchOracleFor(platform, r.userId);
    stats.processed++;

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
        stats.byOutcome.deleted++;
        if (stats.deletedSamples.length < 20) {
          stats.deletedSamples.push({
            id: r.id,
            username: r.username,
            userId: r.userId,
          });
        }
      } else {
        await prisma.testAccount.update({
          where: { id: r.id },
          data: { lastCheckedAt: new Date() },
        });
        stats.byOutcome.error++;
        if (stats.errorsSample.length < 10) {
          stats.errorsSample.push({
            id: r.id,
            message: oracle.message.slice(0, 200),
          });
        }
      }
      continue;
    }

    const renamed =
      oracle.username.length > 0 &&
      oracle.username.toLowerCase() !== r.username.toLowerCase();
    const followersTooHigh =
      oracle.followerCount > cfg.maxFollowerCount;
    const mediaTooHigh = oracle.mediaCount > cfg.invalidateIfMediaAbove;
    const nowPrivate =
      platform === "instagram" && cfg.requireNotPrivate && oracle.isPrivate;

    if (followersTooHigh || mediaTooHigh) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          status: "invalid",
          invalidReason: "became_active",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          active: false,
          ...(renamed ? { username: oracle.username } : {}),
        },
      });
      stats.byOutcome.became_active++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: oracle.username,
        });
      }
      continue;
    }

    if (nowPrivate) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          status: "invalid",
          invalidReason: "became_private",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          active: false,
          ...(renamed ? { username: oracle.username } : {}),
        },
      });
      stats.byOutcome.became_private++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: oracle.username,
        });
      }
      continue;
    }

    if (renamed) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          username: oracle.username,
          lastCheckedAt: new Date(),
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
        },
      });
      stats.byOutcome.renamed++;
      if (stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: oracle.username,
        });
      }
      continue;
    }

    await prisma.testAccount.update({
      where: { id: r.id },
      data: {
        lastCheckedAt: new Date(),
        lastFollowerCount: oracle.followerCount,
        lastMediaCount: oracle.mediaCount,
        lastFollowingCount: oracle.followingCount,
      },
    });
    stats.byOutcome.ok++;
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}

// Back-compat helper; the new sweep endpoint takes ?platform=.
export async function sweepInstagramPool(opts: {
  budgetMs?: number;
  limit?: number;
}): Promise<SweepStats> {
  return sweepPool({ platform: "instagram", ...opts });
}
