// One-shot sweep: walks every IG available account and verifies it
// against an external oracle. Reconciles to:
//
//   deleted         → oracle 404 → status='invalid' reason='deleted'
//   renamed         → oracle returned the same user_id with a
//                     different username → UPDATE username (row stays
//                     available; account is the same, just re-labeled)
//   became_active   → counts exceed PoolConfig thresholds →
//                     status='invalid' reason='became_active'
//   became_private  → oracle says is_private=true and we require
//                     public accounts → status='invalid'
//                     reason='became_private'
//   ok              → still within thresholds; counts + lastCheckedAt
//                     refreshed
//   error           → transient oracle failure (5xx / bad payload /
//                     rate-limit); lastCheckedAt touched so the row
//                     rotates to the back of the queue
//
// Oracle chain (first ok-or-deleted wins, otherwise fall through):
//   1. RapidAPI /userinfo/?username_or_id={userId}  (stable user_id
//      lookup, handles renames natively — the `username` field in the
//      response is the CURRENT handle). Cost: 1 RapidAPI call per row.
//   2. IG mobile i.instagram.com/api/v1/users/{userId}/info/  — same
//      semantics, free, but rate-limits the Vercel IP after ~6 rapid
//      calls (401 "please wait"). Only used as tiebreaker when
//      RapidAPI returns a non-terminal error.

import { prisma } from "@/lib/prisma";
import { fetchIgMobileUserInfo } from "./ig-mobile";
import { getRapidApiKey } from "@/lib/config";
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
  deletedSamples: Array<{ id: number; username: string; userId: string }>;
  errorsSample: Array<{ id: number; message: string }>;
  sourceUsed: { rapidapi: number; ig_mobile: number };
  durationMs: number;
};

type OracleHit =
  | {
      ok: true;
      username: string;
      followerCount: number;
      followingCount: number;
      mediaCount: number;
      isPrivate: boolean;
      source: "rapidapi" | "ig_mobile";
    }
  | { ok: false; reason: "deleted" | "error"; message: string };

async function rapidApiUserInfoById(
  userId: string,
  key: string
): Promise<OracleHit> {
  let res: Response;
  try {
    res = await fetch(
      `https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=${encodeURIComponent(userId)}`,
      {
        headers: {
          "x-rapidapi-key": key,
          "x-rapidapi-host": "instagram-scraper-20251.p.rapidapi.com",
        },
        cache: "no-store",
      }
    );
  } catch (e) {
    return { ok: false, reason: "error", message: (e as Error).message };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "error", message: `non-json ${res.status}` };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.detail === "string" && /not found/i.test(b.detail)) {
    return { ok: false, reason: "deleted", message: b.detail };
  }
  const data = b.data as Record<string, unknown> | undefined;
  if (!data || !data.id) {
    return {
      ok: false,
      reason: "error",
      message: (b.detail as string) ?? `unexpected ${res.status}`,
    };
  }
  return {
    ok: true,
    username: String(data.username ?? ""),
    followerCount: Number(data.follower_count ?? 0),
    followingCount: Number(data.following_count ?? 0),
    mediaCount: Number(data.media_count ?? 0),
    isPrivate: Boolean(data.is_private),
    source: "rapidapi",
  };
}

async function igMobileOracle(userId: string): Promise<OracleHit> {
  const res = await fetchIgMobileUserInfo(userId);
  if (!res.ok) {
    if (res.reason === "deleted") {
      return { ok: false, reason: "deleted", message: res.message };
    }
    return { ok: false, reason: "error", message: `${res.status}: ${res.message}` };
  }
  return {
    ok: true,
    username: res.user.username,
    followerCount: res.user.followerCount,
    followingCount: res.user.followingCount,
    mediaCount: res.user.mediaCount,
    isPrivate: res.user.isPrivate,
    source: "ig_mobile",
  };
}

export async function sweepInstagramPool(opts: {
  budgetMs?: number;
  limit?: number;
}): Promise<SweepStats> {
  const budgetMs = opts.budgetMs ?? 55_000;
  const limit = opts.limit ?? 500;
  const deadline = Date.now() + budgetMs;
  const startedAt = Date.now();

  const cfg = await getPoolConfig();
  const key = await getRapidApiKey();

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
    deletedSamples: [],
    errorsSample: [],
    sourceUsed: { rapidapi: 0, ig_mobile: 0 },
    durationMs: 0,
  };

  for (const r of rows) {
    if (Date.now() > deadline) break;

    // Oracle chain: RapidAPI first, fall back to IG mobile only if
    // RapidAPI errors out (so we don't burn quota on 6 failed
    // mobile-API calls in a row when RapidAPI already gave us a
    // definitive answer).
    let hit: OracleHit = key
      ? await rapidApiUserInfoById(r.userId, key)
      : { ok: false, reason: "error", message: "no rapidapi key" };
    if (hit.ok) stats.sourceUsed.rapidapi++;
    else if (hit.reason === "error") {
      const mobile = await igMobileOracle(r.userId);
      if (mobile.ok || mobile.reason === "deleted") {
        hit = mobile;
        if (mobile.ok) stats.sourceUsed.ig_mobile++;
      }
    }

    stats.processed++;

    if (!hit.ok) {
      if (hit.reason === "deleted") {
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
            message: hit.message.slice(0, 200),
          });
        }
      }
      continue;
    }

    // 200 — account exists. Decide between ok / renamed / became_active /
    // became_private.
    const renamed =
      hit.username.toLowerCase() !== r.username.toLowerCase() &&
      hit.username.length > 0;
    const followersTooHigh =
      hit.followerCount > cfg.invalidateIfFollowerAbove;
    const mediaTooHigh = hit.mediaCount > cfg.invalidateIfMediaAbove;
    const nowPrivate = cfg.requireNotPrivate && hit.isPrivate;

    if (followersTooHigh || mediaTooHigh) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          status: "invalid",
          invalidReason: "became_active",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          lastFollowerCount: hit.followerCount,
          lastMediaCount: hit.mediaCount,
          lastFollowingCount: hit.followingCount,
          active: false,
          ...(renamed ? { username: hit.username } : {}),
        },
      });
      stats.byOutcome.became_active++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: hit.username,
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
          lastFollowerCount: hit.followerCount,
          lastMediaCount: hit.mediaCount,
          lastFollowingCount: hit.followingCount,
          active: false,
          ...(renamed ? { username: hit.username } : {}),
        },
      });
      stats.byOutcome.became_private++;
      if (renamed && stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: hit.username,
        });
      }
      continue;
    }

    if (renamed) {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          username: hit.username,
          lastCheckedAt: new Date(),
          lastFollowerCount: hit.followerCount,
          lastMediaCount: hit.mediaCount,
          lastFollowingCount: hit.followingCount,
        },
      });
      stats.byOutcome.renamed++;
      if (stats.renamedSamples.length < 20) {
        stats.renamedSamples.push({
          id: r.id,
          from: r.username,
          to: hit.username,
        });
      }
      continue;
    }

    await prisma.testAccount.update({
      where: { id: r.id },
      data: {
        lastCheckedAt: new Date(),
        lastFollowerCount: hit.followerCount,
        lastMediaCount: hit.mediaCount,
        lastFollowingCount: hit.followingCount,
      },
    });
    stats.byOutcome.ok++;
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}
