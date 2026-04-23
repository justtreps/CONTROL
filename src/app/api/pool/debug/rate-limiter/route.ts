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
  const snapshot = await ig429SnapshotForDebug();
  return NextResponse.json(snapshot);
}
