// Terminal stop — operator cancels the campaign entirely. Running
// tests in flight still finalize via the normal poller; only new
// placements are inhibited.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  const c = await prisma.scoringCampaign.findFirst({
    where: { status: { in: ["running", "paused"] } },
  });
  if (!c) {
    return NextResponse.json({ error: "no_active_campaign" }, { status: 404 });
  }
  const updated = await prisma.scoringCampaign.update({
    where: { id: c.id },
    data: {
      status: "stopped_manual",
      stopReason: "operator_cancel",
      finishedAt: new Date(),
    },
  });
  return NextResponse.json({ ok: true, campaign: updated });
}
