// One-shot — backfills Service.lastTestedAt from MAX(TestOrder.placedAt)
// grouped by serviceId. Idempotent: running it again is a no-op
// because the new TestOrder.create hook now stamps lastTestedAt in
// real-time.
//
// Auth: Bearer CRON_SECRET so the operator can curl it after the
// column ships. Sits under /api/pool/ + listed in PUBLIC_PATHS so
// the session-auth middleware doesn't block the curl.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // One SQL round-trip — cheaper than N per-service updates.
  // lastTestedAt is nullable, so COALESCE lets us either stamp from
  // the subquery result or leave it null (service never tested).
  const rowsAffected = await prisma.$executeRaw`
    UPDATE "Service" s
    SET "lastTestedAt" = agg.max_placed_at
    FROM (
      SELECT "serviceId", MAX("placedAt") AS max_placed_at
      FROM "TestOrder"
      GROUP BY "serviceId"
    ) agg
    WHERE s.id = agg."serviceId"
      AND (
        s."lastTestedAt" IS NULL
        OR s."lastTestedAt" < agg.max_placed_at
      )
  `;

  const neverTested = await prisma.service.count({
    where: { lastTestedAt: null, active: true },
  });
  const totalActive = await prisma.service.count({ where: { active: true } });

  return NextResponse.json({
    ok: true,
    rowsUpdated: rowsAffected,
    neverTested,
    totalActive,
  });
}

export const GET = POST;
