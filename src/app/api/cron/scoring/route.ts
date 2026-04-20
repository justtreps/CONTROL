import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { runScoringEngine } from "@/lib/scoring";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const toggles = await getSystemToggles();
  if (!toggles.scoringEngineEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }
  try {
    const result = await runScoringEngine();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
