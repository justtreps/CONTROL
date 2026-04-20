// Remediation endpoint — reactivates rows that were wrongly flipped
// to status='invalid' reason='became_active' under the old media-
// count rule but still qualify under the current (follower + following
// only) criteria.
//
// Eligible: status='invalid' AND reason='became_active' AND
//   lastFollowerCount ≤ followerCap (default from PoolConfig) AND
//   lastFollowingCount ≤ followingCap (default from PoolConfig)
//
// Rows with 'deleted' / 'became_private' / 'manual' / 'banned' are
// untouched. Rows that grew past the follower cap stay invalid.
// Idempotent: safe to re-run; once reactivated a row is no longer a
// candidate (its status isn't 'invalid' anymore).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "@/lib/pool/config";

export const maxDuration = 30;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const cfg = await getPoolConfig();

  const followerCap = Math.max(
    0,
    Number(url.searchParams.get("followerCap") ?? cfg.invalidateIfFollowerAbove) || cfg.invalidateIfFollowerAbove
  );
  const followingCap = Math.max(
    0,
    Number(url.searchParams.get("followingCap") ?? cfg.maxFollowingCount) || cfg.maxFollowingCount
  );
  const dryRun = url.searchParams.get("dryRun") === "1";

  const whereEligible: import("@prisma/client").Prisma.TestAccountWhereInput = {
    status: "invalid",
    invalidReason: "became_active",
    AND: [
      {
        OR: [
          { lastFollowerCount: null },
          { lastFollowerCount: { lte: followerCap } },
        ],
      },
      {
        OR: [
          { lastFollowingCount: null },
          { lastFollowingCount: { lte: followingCap } },
        ],
      },
    ],
  };

  try {
    const candidates = await prisma.testAccount.findMany({
      where: whereEligible,
      select: {
        id: true,
        platform: true,
        username: true,
        lastFollowerCount: true,
        lastMediaCount: true,
        lastFollowingCount: true,
      },
    });

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        followerCap,
        followingCap,
        candidates: candidates.length,
        sample: candidates.slice(0, 10),
      });
    }

    const res = await prisma.testAccount.updateMany({
      where: whereEligible,
      data: {
        status: "available",
        invalidReason: null,
        invalidatedAt: null,
        active: true,
      },
    });

    return NextResponse.json({
      ok: true,
      reactivated: res.count,
      followerCap,
      followingCap,
      sample: candidates.slice(0, 10),
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
