// The heart of the pool system. Called every minute by Vercel Cron.
// Runs exactly one tranche (~8s) of whichever job is oldest and still
// pending/running. Safe to call more frequently — it's a no-op when
// there's nothing to do.
//
// Gated on poolScrapeEnabled — same kill switch as /api/pool/scrape
// since the orchestrator's primary work is dispatching scrape ticks.
// Without this, an operator who flips the kill switch off sees
// /api/pool/scrape refuse new jobs but the orchestrator keeps
// running queued jobs from the table — confusing and unsafe.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runOrchestratorTick } from "@/lib/pool/orchestrator";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  const toggles = await getSystemToggles();
  if (!toggles.poolScrapeEnabled) {
    console.log(`[pool-orchestrator] skipped: poolScrapeEnabled=false`);
    return NextResponse.json({ ok: true, skipped: "pool_scrape_disabled" });
  }
  try {
    const result = await runOrchestratorTick();
    console.log(
      `[pool-orchestrator] elapsed=${Date.now() - t0}ms ` +
        `result=${JSON.stringify(result)}`
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error(
      `[pool-orchestrator] error=${(e as Error).message} elapsed=${Date.now() - t0}ms`
    );
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
