// Campaign list + create. A single campaign can be active at a
// time (status in running/paused). On creation, the lib snapshots
// the target service IDs + computes estimated cost.
//
// NOTE: we always persist the campaign in a *running* state. The
// operator confirms the launch by POSTing here — the UI is
// responsible for showing the estimated cost beforehand.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { launchCampaign } from "@/lib/scoring/campaign";

export const dynamic = "force-dynamic";

export async function GET() {
  const campaigns = await prisma.scoringCampaign.findMany({
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      ...c,
      startedAt: c.startedAt.toISOString(),
      finishedAt: c.finishedAt?.toISOString() ?? null,
      updatedAt: c.updatedAt.toISOString(),
      // Flatten the target list count — raw array of 3000+ ints
      // bloats the JSON unnecessarily.
      targetServiceIds: undefined,
      placedServiceIds: undefined,
      targetCount: c.targetServiceIds.length,
      placedCount: c.placedServiceIds.length,
    })),
  });
}

export async function POST() {
  const result = await launchCampaign();
  if ("error" in result) {
    const status = result.error === "no_services_to_test" ? 400 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, ...result });
}
