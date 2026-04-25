// Every 1 min: tick the brute-force placement campaign. Picks
// the lone scoringCampaign row with status='running' AND
// stopReason='brute_mode' and processes BATCH_SIZE_BRUTE
// services per tick (50 in parallel). See
// lib/scoring/brute-campaign.ts for the placement contract.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runBruteCampaignTick } from "@/lib/scoring/brute-campaign";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runBruteCampaignTick();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
