// One-shot — runs recomputeRanks() in isolation.
//
// The full /api/cron/scoring path runs runScoringEngine first
// (rebuilds ServiceScore rows for every active service) which can
// hit the 300 s lambda ceiling on big catalogs. When the operator
// just wants the ranking refreshed (e.g. after backfilling
// reliability or flipping a toggle that changes the tie-break), we
// don't need the full engine pass — recomputeRanks reads the
// already-persisted currentScore + reliability columns and
// rewrites PSC.rank in one transaction per product. ~10-20 s wall
// even on a large catalog.
//
// Auth: Bearer CRON_SECRET, same pattern as the other one-shots.
//
// Idempotent — recomputeRanks is deterministic given the input
// (currentScore, reliability, tier). Safe to call repeatedly.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { recomputeRanks } from "@/lib/scoring";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    await recomputeRanks();
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: (e as Error).message,
        elapsedMs: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}

export const GET = POST;
