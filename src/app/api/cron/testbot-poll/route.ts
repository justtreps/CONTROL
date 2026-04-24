// Every 1 min: pick all TestOrders that are `running` + whose
// pollingState.nextPollAt has elapsed, and tick them through
// runAdaptivePoller.
//
// Replaces the old /api/cron/scraper fixed-checkpoint flow. When
// SystemToggle.adaptivePollingEnabled=false, the same poller runs
// but with a flat 30-min cadence — kill switch for safety.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getSystemToggles } from "@/lib/system/toggles";
import { runAdaptivePoller } from "@/lib/testbot/poller";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const toggles = await getSystemToggles();
  // testBotEnabled gates BOTH the placement bot AND the poller — if
  // the operator paused the test-bot, we shouldn't be racking up
  // retry spend either.
  if (!toggles.testBotEnabled) {
    return NextResponse.json({ ok: true, skipped: "test_bot_disabled" });
  }
  try {
    const result = await runAdaptivePoller();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
