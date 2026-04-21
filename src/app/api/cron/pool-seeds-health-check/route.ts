// Daily cron (03:00 UTC) — runs runSeedsHealthCheck() which iterates
// every enabled PoolSeedAccount, calls the oracle, and either:
//   • deletes dead seeds + replaces them from the suggestions cache,
//   • updates the username on renamed seeds,
//   • bumps lastCheckedAt on healthy ones.
//
// Auth: Bearer CRON_SECRET (set by Vercel Cron automatically).
//
// Also honors the existing SystemToggle.poolHealthcheckEnabled kill
// switch so operators can pause both account AND seeds checks with
// one toggle during an incident.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getSystemToggles } from "@/lib/system/toggles";
import { runSeedsHealthCheck } from "@/lib/pool/seeds-health-check";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }
  try {
    const stats = await runSeedsHealthCheck();
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
