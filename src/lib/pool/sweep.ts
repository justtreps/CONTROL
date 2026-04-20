// One-shot sweep: walks every IG available account in the pool and
// verifies it against the Instagram mobile API oracle. Each row is
// reconciled to one of four outcomes:
//
//   deleted         → IG returned 404 → status='invalid' reason='deleted'
//   renamed         → IG returned 200 with a different username →
//                     UPDATE username (account stays available, just
//                     re-labeled)
//   became_active   → IG counts exceed PoolConfig thresholds →
//                     status='invalid' reason='became_active'
//   ok              → IG confirms account + counts still within limits
//
// Counts + lastCheckedAt are updated on every row we touched.

import { prisma } from "@/lib/prisma";
import { fetchIgMobileUserInfo } from "./ig-mobile";
import { getPoolConfig } from "./config";

export type SweepOutcome =
  | "deleted"
  | "renamed"
  | "became_active"
  | "became_private"
  | "ok"
  | "error";

export type SweepStats = {
  total: number;
  processed: number;
  byOutcome: Record<SweepOutcome, number>;
  renamedSamples: Array<{ id: number; from: string; to: string }>;
  errorsSample: Array<{ id: number; message: string }>;
  durationMs: number;
};

export async function sweepInstagramPool(opts: {
  budgetMs?: number;
  limit?: number;
}): Promise<SweepStats> {
  const budgetMs = opts.budgetMs ?? 55_000;
  const limit = opts.limit ?? 500;
  const deadline = Date.now() + budgetMs;
  const startedAt = Date.now();

  const cfg = await getPoolConfig();

  const rows = await prisma.testAccount.findMany({
    where: { platform: "instagram", status: "available" },
    orderBy: { lastCheckedAt: "asc" },
    take: limit,
    select: {
      id: true,
      username: true,
      userId: true,
      lastFollowerCount: true,
      lastMediaCount: true,
      lastFollowingCount: true,
    },
  });

  const stats: SweepStats = {
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
    errorsSample: [],
    durationMs: 0,
  };

  for (const r of rows) {
    if (Date.now() > deadline) break;

    const res = await fetchIgMobileUserInfo(r.userId);
    stats.processed++;

    if (!res.ok) {
      if (res.reason === "deleted") {
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
      } else {
        // http_error / bad_payload — don't flip status, just log + touch
        // lastCheckedAt so the row doesn't get stuck at the top of the
        // queue forever. Real persistent failures will show up in
        // errorsSample for investigation.
        await prisma.testAccount.update({
          where: { id: r.id },
          data: { lastCheckedAt: new Date() },
        });
        stats.byOutcome.error++;
        if (stats.errorsSample.length < 10) {
          stats.errorsSample.push({
            id: r.id,
            message: `${res.status}: ${res.message.slice(0, 120)}`,
          });
        }
      }
      continue;
    }

    // 200 — account exists. Decide between ok / renamed / became_active /
    // became_private.
    const renamed =
      res.user.username.toLowerCase() !== r.username.toLowerCase();
    const followersTooHigh =
      res.user.followerCount > cfg.invalidateIfFollowerAbove;
    const mediaTooHigh = res.user.mediaCount > cfg.invalidateIfMediaAbove;
    const nowPrivate = cfg.requireNotPrivate && res.user.isPrivate;

    if (followersTooHigh || mediaTooHigh) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          status: "invalid",
          invalidReason: "became_active",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          lastFollowerCount: res.user.followerCount,
          lastMediaCount: res.user.mediaCount,
          lastFollowingCount: res.user.followingCount,
          active: false,
          // Sync username even when invalidating — useful for audit.
          ...(renamed ? { username: res.user.username } : {}),
        },
      });
      stats.byOutcome.became_active++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: res.user.username,
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
          lastFollowerCount: res.user.followerCount,
          lastMediaCount: res.user.mediaCount,
          lastFollowingCount: res.user.followingCount,
          active: false,
          ...(renamed ? { username: res.user.username } : {}),
        },
      });
      stats.byOutcome.became_private++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: res.user.username,
        });
      }
      continue;
    }

    if (renamed) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          username: res.user.username,
          lastCheckedAt: new Date(),
          lastFollowerCount: res.user.followerCount,
          lastMediaCount: res.user.mediaCount,
          lastFollowingCount: res.user.followingCount,
        },
      });
      stats.byOutcome.renamed++;
      if (stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: res.user.username,
        });
      }
      continue;
    }

    await prisma.testAccount.update({
      where: { id: r.id },
      data: {
        lastCheckedAt: new Date(),
        lastFollowerCount: res.user.followerCount,
        lastMediaCount: res.user.mediaCount,
        lastFollowingCount: res.user.followingCount,
      },
    });
    stats.byOutcome.ok++;
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}
