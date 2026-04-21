// Manual on-demand trigger for the seeds health check. Protected by
// the session cookie (auto-applied by middleware — no additional auth
// needed here). Clicked from the [⚡ LANCER VÉRIFICATION MAINTENANT]
// button at the bottom of the seeds sub-section.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runSeedsHealthCheck } from "@/lib/pool/seeds-health-check";

export const maxDuration = 60;

export async function POST() {
  try {
    // Log the manual trigger itself so the history reflects "a human
    // kicked this off at 21/04 14:22" before the per-seed lines.
    await prisma.poolSeedHealthLog.create({
      data: {
        platform: "all",
        action: "manual_trigger",
        seedUsername: "",
        reason: "manual trigger from /pool UI",
      },
    });
    const stats = await runSeedsHealthCheck();
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
