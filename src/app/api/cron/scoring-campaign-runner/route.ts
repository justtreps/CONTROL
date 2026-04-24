// Every 1 min: run one tick of the active campaign. See
// lib/scoring/campaign.ts for the BATCH_SIZE + safety semantics.
// Idempotent — no-op when no active campaign.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runCampaignTick } from "@/lib/scoring/campaign";

// 60s is plenty for 25 placements — each ~1-2s of RapidAPI work
// serialised through the per-key rate limiter.
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
