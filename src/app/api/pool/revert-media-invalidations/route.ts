// One-shot remediation endpoint. The prior PoolConfig defaults
// rejected accounts that had ANY media_count > 0, so the health
// check + sweep wrongly flipped rows to status='invalid' reason=
// 'became_active' for accounts that actually still qualify under
// the current (follower-only) rules.
//
// This route finds those rows — status='invalid' AND
// invalidReason='became_active' AND lastFollowerCount <= 5 — and
// reactivates them: status='available', reason/invalidatedAt
// cleared, active=true. It doesn't touch anything that was
// invalidated for a different reason (deleted / became_private /
// manual / banned) or that actually has too many followers.
//
// Will be deleted once it runs cleanly.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const followerCap = Math.max(
    0,
    Number(url.searchParams.get("followerCap") ?? 5) || 5
  );
  const dryRun = url.searchParams.get("dryRun") === "1";

  try {
    const candidates = await prisma.testAccount.findMany({
      where: {
        status: "invalid",
        invalidReason: "became_active",
        OR: [
          { lastFollowerCount: null },
          { lastFollowerCount: { lte: followerCap } },
        ],
      },
      select: {
        id: true,
        platform: true,
        username: true,
        lastFollowerCount: true,
        lastMediaCount: true,
      },
    });

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        candidates: candidates.length,
        sample: candidates.slice(0, 10),
      });
    }

    const res = await prisma.testAccount.updateMany({
      where: {
        status: "invalid",
        invalidReason: "became_active",
        OR: [
          { lastFollowerCount: null },
          { lastFollowerCount: { lte: followerCap } },
        ],
      },
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
      sample: candidates.slice(0, 10),
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
