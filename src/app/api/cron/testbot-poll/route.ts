// Hourly: pick all TestOrders where status='running' and
// nextPollAt <= now, run one poll per order (single RapidAPI
// call, write Measurement, schedule next). The fixed 12 h cadence
// means each order hits the poller 14 times over its 7-day life.
// See lib/testbot/poller.ts for the full flow.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getSystemToggles } from "@/lib/system/toggles";
import { runPoller } from "@/lib/testbot/poller";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const toggles = await getSystemToggles();
  // testBotEnabled gates BOTH the placement bot AND the poller — if
  // the operator paused the test-bot, we shouldn't keep polling
  // in-flight orders either (wastes RapidAPI quota on a dead run).
  if (!toggles.testBotEnabled) {
    return NextResponse.json({ ok: true, skipped: "test_bot_disabled" });
  }
  try {
    const result = await runPoller();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
