// One-shot — repairs ProductServiceCandidate.lifecycleStatus rows
// that drifted out of their definitional invariants.
//
// Invariants enforced:
//
//   QUALIFIED ⇒ the underlying Service has at least one TestOrder
//               that delivered something measurable (a non-T+0
//               Measurement with actualCount > baselineCount).
//
//   MONITORED ⇒ QUALIFIED + at least 2 finalised TestOrders
//               (status IN completed | completed_partial). The
//               daily-retest cron picks MONITORED candidates so a
//               row stuck at "monitored with only 1 finalised
//               test" is a definitional contradiction that lets
//               broken-flow data dominate ranking.
//
// Repair logic (idempotent):
//
//   QUALIFIED-no-delivery → demote to TESTING. The row will
//                            naturally re-promote on its next
//                            measured delivery via
//                            onMeasurementWritten.
//
//   MONITORED-with-<2-finalized → demote to QUALIFIED if the
//                            service has at least one delivered
//                            test (the QUALIFIED invariant is met),
//                            otherwise to TESTING.
//
// The audit surfaced 142 + 764 rows in these two states on
// 2026-05-03 — almost all of them are residual fallout from the
// engagement-routing recovery (broken-flow tests left services
// MONITORED but the only "finalised" rows got marked
// aborted_misplaced, dropping them below the threshold).
//
// Auth: Bearer CRON_SECRET. Whitelisted in middleware.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();

  // ── Repair 1: QUALIFIED-no-delivery → TESTING ──
  // SQL: find PSC rows in QUALIFIED whose service has 0 delivered
  // TestOrders, demote them to TESTING. Single round-trip via
  // executeRaw — JOIN-based UPDATE.
  const qualToTesting = await prisma.$executeRaw`
    UPDATE "ProductServiceCandidate" psc
    SET "lifecycleStatus" = 'TESTING'
    WHERE psc."lifecycleStatus" = 'QUALIFIED'
      AND psc."isEligible" = true
      AND NOT EXISTS (
        SELECT 1 FROM "TestOrder" tor
        JOIN "Measurement" m ON m."testOrderId" = tor.id
        WHERE tor."serviceId" = psc."serviceId"
          AND tor.status IN ('completed', 'completed_partial', 'running')
          AND m.checkpoint != 'T+0'
          AND m."actualCount" > tor."baselineCount"
      )
  `;

  // ── Repair 2: MONITORED-low-tests → QUALIFIED or TESTING ──
  // First, the ones with at least one delivery → QUALIFIED. Then
  // the ones without delivery → TESTING (covers the rare service
  // that somehow landed MONITORED without ever delivering).
  const monToQualified = await prisma.$executeRaw`
    UPDATE "ProductServiceCandidate" psc
    SET "lifecycleStatus" = 'QUALIFIED'
    WHERE psc."lifecycleStatus" = 'MONITORED'
      AND (
        SELECT COUNT(*) FROM "TestOrder" tor
        WHERE tor."serviceId" = psc."serviceId"
          AND tor.status IN ('completed', 'completed_partial')
      ) < 2
      AND EXISTS (
        SELECT 1 FROM "TestOrder" tor
        JOIN "Measurement" m ON m."testOrderId" = tor.id
        WHERE tor."serviceId" = psc."serviceId"
          AND tor.status IN ('completed', 'completed_partial', 'running')
          AND m.checkpoint != 'T+0'
          AND m."actualCount" > tor."baselineCount"
      )
  `;
  const monToTesting = await prisma.$executeRaw`
    UPDATE "ProductServiceCandidate" psc
    SET "lifecycleStatus" = 'TESTING'
    WHERE psc."lifecycleStatus" = 'MONITORED'
      AND (
        SELECT COUNT(*) FROM "TestOrder" tor
        WHERE tor."serviceId" = psc."serviceId"
          AND tor.status IN ('completed', 'completed_partial')
      ) < 2
  `;

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    qualifiedToTesting: Number(qualToTesting),
    monitoredToQualified: Number(monToQualified),
    monitoredToTesting: Number(monToTesting),
    note: "Lifecycle invariants restored. Run /api/scoring/recompute-ranks (or wait next scoring cron) for the new statuses to propagate to PSC.rank.",
  });
}

export const GET = POST;
