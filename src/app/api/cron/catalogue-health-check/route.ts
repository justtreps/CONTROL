// Daily 03:00 UTC — full catalogue health check. See
// lib/catalogue/health-check.ts for the contract.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runCatalogueHealthCheck } from "@/lib/catalogue/health-check";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // dailySyncEnabled gates the health check — phase D fires real
  // BulkMedya probe orders against PLACEMENT_FAILED services
  // (cap 200/run) and phase F auto-places NEW services. Both
  // cost BulkMedya credits + RapidAPI quota.
  // testBotEnabled is the harder gate: if the operator killed
  // the test-bot entirely, even sync should skip.
  const toggles = await getSystemToggles();
  if (!toggles.dailySyncEnabled) {
    return NextResponse.json({ ok: true, skipped: "daily_sync_disabled" });
  }
  if (!toggles.testBotEnabled) {
    return NextResponse.json({ ok: true, skipped: "test_bot_disabled" });
  }
  try {
    const summary = await runCatalogueHealthCheck();
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
