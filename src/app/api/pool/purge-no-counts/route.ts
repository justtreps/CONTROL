// One-shot admin helper — deletes test accounts that were scraped by
// method A (`big_account_followers`) but never got counts because the
// old scraper didn't call /user/info. These rows are suspect (could
// easily be non-virgin) and must be re-scraped with the fixed path.
//
// Safe guardrails:
//  - only rows with status='available' (never touch assigned/consumed)
//  - only scrapeSource='big_account_followers'
//  - only when all 3 counts are null
// Nothing else gets deleted.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

export async function POST() {
  try {
    const where = {
      scrapeSource: "big_account_followers",
      status: "available",
      lastFollowerCount: null,
      lastMediaCount: null,
      lastFollowingCount: null,
    } as const;

    const sample = await prisma.testAccount.findMany({
      where,
      take: 5,
      select: { id: true, platform: true, username: true },
    });

    const res = await prisma.testAccount.deleteMany({ where });

    return NextResponse.json({
      ok: true,
      deleted: res.count,
      sample,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
