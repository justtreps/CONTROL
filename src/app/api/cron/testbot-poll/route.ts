// Hourly: pick all TestOrders where status='running' and
// nextPollAt <= now, run one poll per order (single RapidAPI
// call, write Measurement, schedule next). The fixed 12 h cadence
// means each order hits the poller 14 times over its 7-day life.
// See lib/testbot/poller.ts for the full flow.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getSystemToggles } from "@/lib/system/toggles";
import { runPoller } from "@/lib/testbot/poller";

// 60s was bottlenecking the poller — observed ~218 polls/h
// vs MAX_ORDERS_PER_TICK=500 cap because each tick exited at the
// 60s deadline mid-batch. With 2700+ running orders on a 12h
// cadence we need ~225 polls/h steady-state, but a backlog of
// 1600+ due polls accumulates without headroom. 300s lets the
// poller drain the cap when needed.
export const maxDuration = 300;

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
