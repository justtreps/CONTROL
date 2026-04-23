// Live snapshot of the IG RapidAPI rate-limiter window. Session-auth
// gate comes from middleware (debug routes aren't in PUBLIC_PATHS),
// so an operator on /pool can poll this every 5s without exposing
// it to the open web.

import { NextResponse } from "next/server";
import { ig429SnapshotForDebug } from "@/lib/rapidapi/rate-limit";

export const maxDuration = 10;
// Always fresh — the whole point is to see live quota usage.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await ig429SnapshotForDebug();
    return NextResponse.json(snapshot);
  } catch (e) {
    // Surface the real reason so the UI polling block can show it
    // instead of the endpoint 500'ing with an empty body (we had
    // that on the first deploy and couldn't tell why from prod logs).
    return NextResponse.json(
      {
        backend: "in-memory",
        inFlightWindowSize: 0,
        maxPerWindow: 85,
        error: `snapshot endpoint crashed: ${(e as Error).message.slice(0, 200)}`,
      },
      { status: 200 }
    );
  }
}
