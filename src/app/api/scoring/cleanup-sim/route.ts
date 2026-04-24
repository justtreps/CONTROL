// One-shot — flips every TestOrder with bulkmedyaOrderId starting
// by "sim-" AND status='running' to status='completed_simulated'.
// These rows were placed in the pre-e306736 era when the testbot
// was in simulated mode (no real BulkMedya call) — they will never
// have a delivery to measure and the poller can't finalize them.
//
// Leaves real-id running rows untouched; they finalize naturally
// at T+7d.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Single UPDATE — cheaper than the per-row loop and the server
  // returns the count of affected rows.
  const affected = await prisma.$executeRaw`
    UPDATE "TestOrder"
    SET "status" = 'completed_simulated',
        "completedAt" = NOW(),
        "dryRun" = TRUE,
        "pollingState" = NULL
    WHERE "status" = 'running'
      AND "bulkmedyaOrderId" LIKE 'sim-%'
  `;

  return NextResponse.json({
    ok: true,
    rowsUpdated: affected,
  });
}

export const GET = POST;
