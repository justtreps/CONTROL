// Pause the active campaign — cron runner skips status='paused'.
// Tests already in flight keep finishing via the normal poller.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  const c = await prisma.scoringCampaign.findFirst({
    where: { status: "running" },
  });
  if (!c) {
    return NextResponse.json({ error: "no_running_campaign" }, { status: 404 });
  }
  const updated = await prisma.scoringCampaign.update({
    where: { id: c.id },
    data: { status: "paused" },
  });
  return NextResponse.json({ ok: true, campaign: updated });
}
