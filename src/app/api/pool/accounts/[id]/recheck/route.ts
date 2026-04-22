// Force-recheck a single TestAccount immediately (bypasses the
// orchestrator). Mirrors the daily health-check classification path:
//
//   oracle.ghost                               → invalidReason='deleted'
//   oracle.error                               → transient, only bump lastCheckedAt
//   oracle.ok + followerCount > threshold      → invalidReason='became_active'
//   oracle.ok + mediaCount > threshold         → invalidReason='became_active'
//   oracle.ok + isPrivate (IG only)            → invalidReason='became_private'
//   oracle.ok + renamed                        → UPDATE username in place
//   oracle.ok + healthy                        → refresh counts + lastCheckedAt
//
// The old implementation called fetchInstagramFollowers(username) /
// fetchTikTokFollowers(userId) directly, which (a) looked up IG by
// the unstable username — so a deleted account whose handle was
// reused by someone else looked like "became_active" — and (b) could
// silently swallow a TT 404 as count=0 and leave the row available.
// Using the oracle (user_id based) fixes both.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchOracleFor } from "@/lib/pool/oracle";
import { getPoolConfig } from "@/lib/pool/config";

export const maxDuration = 30;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await prisma.testAccount.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cfg = await getPoolConfig();
  const now = new Date();

  const oracle = await fetchOracleFor(row.platform, row.userId);

  // --- Ghost: the user_id no longer resolves on the provider. Mark
  // as deleted regardless of any prior stored state.
  if (!oracle.ok && oracle.reason === "ghost") {
    const updated = await prisma.testAccount.update({
      where: { id },
      data: {
        status: "invalid",
        invalidReason: "deleted",
        invalidatedAt: now,
        lastCheckedAt: now,
        active: false,
      },
    });
    return NextResponse.json({
      ok: true,
      row: updated,
      invalidatedReason: "deleted",
    });
  }

  // --- Transient provider error: don't touch invalidation state,
  // just bump lastCheckedAt and surface the error to the caller so
  // the UI can toast it instead of pretending everything's fine.
  if (!oracle.ok) {
    await prisma.testAccount.update({
      where: { id },
      data: { lastCheckedAt: now },
    });
    return NextResponse.json(
      {
        ok: false,
        row: { ...row, lastCheckedAt: now },
        error: `oracle_error: ${oracle.message.slice(0, 160)}`,
      },
      { status: 502 }
    );
  }

  // --- Oracle says alive: classify against config thresholds.
  const renamed =
    oracle.username.length > 0 &&
    oracle.username.toLowerCase() !== row.username.toLowerCase();

  const followerCap =
    row.platform === "tiktok"
      ? cfg.maxFollowerCountTiktok
      : cfg.maxFollowerCount;

  let invalidReason: string | null = null;
  if (oracle.followerCount > followerCap)
    invalidReason = "became_active";
  else if (oracle.mediaCount > cfg.invalidateIfMediaAbove)
    invalidReason = "became_active";
  else if (oracle.followingCount > cfg.maxFollowingCount)
    invalidReason = "became_active";
  else if (row.platform === "instagram" && oracle.isPrivate)
    invalidReason = "became_private";

  const updated = await prisma.testAccount.update({
    where: { id },
    data: invalidReason
      ? {
          status: "invalid",
          invalidReason,
          invalidatedAt: now,
          lastCheckedAt: now,
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          active: false,
          ...(renamed ? { username: oracle.username } : {}),
        }
      : {
          lastCheckedAt: now,
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
          ...(renamed ? { username: oracle.username } : {}),
        },
  });

  return NextResponse.json({
    ok: true,
    row: updated,
    invalidatedReason: invalidReason,
    renamed: renamed ? { from: row.username, to: oracle.username } : null,
  });
}
