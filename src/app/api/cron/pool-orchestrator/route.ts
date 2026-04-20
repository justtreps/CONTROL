// The heart of the pool system. Called every minute by Vercel Cron.
// Runs exactly one tranche (~8s) of whichever job is oldest and still
// pending/running. Safe to call more frequently — it's a no-op when
// there's nothing to do.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runOrchestratorTick } from "@/lib/pool/orchestrator";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runOrchestratorTick();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
