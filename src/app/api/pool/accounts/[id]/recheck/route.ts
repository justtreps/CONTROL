// Force-recheck a single account immediately (bypasses the orchestrator).
// Useful when an admin suspects a row is stale. Runs the same probe logic
// as the health-check tranche but on one row.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchInstagramFollowers } from "@/lib/rapidapi/instagram";
import { fetchTikTokFollowers } from "@/lib/rapidapi/tiktok";
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

  try {
    let followerCount = 0;
    let isPrivate = false;
    if (row.platform === "instagram") {
      const r = await fetchInstagramFollowers(row.username);
      followerCount = r.count;
      isPrivate = Boolean(r.sample[0]?.is_private);
    } else if (row.platform === "tiktok") {
      const r = await fetchTikTokFollowers(row.userId);
      followerCount = r.count;
    } else {
      return NextResponse.json(
        { error: "unsupported_platform" },
        { status: 400 }
      );
    }

    let invalidReason: string | null = null;
    if (followerCount > cfg.invalidateIfFollowerAbove)
      invalidReason = "became_active";
    else if (row.platform === "instagram" && isPrivate)
      invalidReason = "became_private";

    const updated = await prisma.testAccount.update({
      where: { id },
      data: invalidReason
        ? {
            status: "invalid",
            invalidReason,
            invalidatedAt: new Date(),
            lastCheckedAt: new Date(),
            lastFollowerCount: followerCount,
            active: false,
          }
        : {
            lastCheckedAt: new Date(),
            lastFollowerCount: followerCount,
          },
    });

    return NextResponse.json({
      ok: true,
      row: updated,
      invalidatedReason: invalidReason,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 404 from RapidAPI means the account no longer exists.
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) {
      const updated = await prisma.testAccount.update({
        where: { id },
        data: {
          status: "invalid",
          invalidReason: "deleted",
          invalidatedAt: new Date(),
          lastCheckedAt: new Date(),
          active: false,
        },
      });
      return NextResponse.json({
        ok: true,
        row: updated,
        invalidatedReason: "deleted",
      });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
