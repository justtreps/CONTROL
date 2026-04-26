// Every 1 min: run one tick of the active campaign. See
// lib/scoring/campaign.ts for the BATCH_SIZE + safety semantics.
// Idempotent — no-op when no active campaign.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runCampaignTick } from "@/lib/scoring/campaign";
import { getSystemToggles } from "@/lib/system/toggles";

// 300 s ceiling. Observed: each placement is ~8-10 s wall-time
// (oracle + realism sample + BulkMedya + DB writes) → a 10-
// placement batch runs ~80-100 s. 300 s leaves ample headroom.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // testBotEnabled gates this runner — it places real BulkMedya
  // orders. If the operator killed the testbot, the campaign
  // shouldn't keep burning BulkMedya budget.
  const toggles = await getSystemToggles();
  if (!toggles.testBotEnabled) {
    return NextResponse.json({ ok: true, skipped: "test_bot_disabled" });
  }
  try {
    const r = await runCampaignTick();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
