// Resume a paused campaign — status returns to 'running' and the
// cron runner picks it back up on the next tick.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  const c = await prisma.scoringCampaign.findFirst({
    where: { status: "paused" },
  });
  if (!c) {
    return NextResponse.json({ error: "no_paused_campaign" }, { status: 404 });
  }
  const updated = await prisma.scoringCampaign.update({
    where: { id: c.id },
    data: { status: "running" },
  });
  return NextResponse.json({ ok: true, campaign: updated });
}
