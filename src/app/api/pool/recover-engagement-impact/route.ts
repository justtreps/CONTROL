// One-shot — recovers ProductServiceCandidate state for engagement
// services that were demoted / killed by the account-flow placement
// bug.
//
// Background: from ~2026-04-01 to 2026-05-02, every TestOrder for
// services with serviceType IN (likes, views, shares, saves,
// comments) was placed via pickAndAssignAccount instead of
// pickAndAssignPost (the routing keyed off a too-narrow poolType
// check). BulkMedya rejected the profile-URL deliveries; the
// poller measured zero delta on the parent's followerCount; the
// 3-zero / 6-zero kill rules then demoted ~994 services to TESTING,
// killed 13 with DEAD/PERMANENTLY_FAILED, and produced a Service
// active=false on many. /api/pool/reconcile-engagement fixed the
// TestOrders side (marked them aborted_misplaced) but the
// downstream lifecycle damage stayed.
//
// This endpoint repairs that damage:
//   1. Idempotently re-runs the misplaced-marker (catches new rows
//      placed since the last reconcile).
//   2. For every Service.serviceType IN engagement_metrics that had
//      at least one aborted_misplaced TestOrder:
//        a. Service.active → true (if false). Classifier-disabled
//           services are re-enabled here; reclassify-services can
//           re-disable on its next pass if any of them genuinely
//           shouldn't be active. The asymmetric choice (re-enable
//           freely) is safe: a re-enabled service will simply be
//           retested through post-flow and either qualify or
//           re-die through the legitimate lifecycle.
//        b. PSC.lifecycleStatus DEAD / PERMANENTLY_FAILED → TESTING
//           + isEligible=true. Same semantics as reviveService.
//        c. PSC.currentScore → null. The previous value was
//           computed from broken-flow Measurement rows; null lets
//           the score engine recompute fresh on the next tick (or
//           leave the row in tier 3 = in-flight if no post-flow
//           test has finalised yet).
//   3. Resolves any service_killed_no_delivery alerts on the
//      restored services.
//   4. Returns counts for operator validation.
//
// Does NOT touch: reliabilityScore (already null for the cohort —
// the recompute-reliability backfill correctly excluded
// aborted_misplaced rows from the formula), Service.poolType (the
// classifier owns it; reclassify-services has already run),
// TestOrder rows that had testPostId set (those are legitimate
// post-flow tests).
//
// Auth: Bearer CRON_SECRET. Whitelisted in middleware.
//
// Idempotent — re-running it is a no-op once the cohort is healed.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 120;

const ENGAGEMENT_METRICS = [
  "likes",
  "like",
  "views",
  "view",
  "plays",
  "play",
  "comments",
  "comment",
  "shares",
  "share",
  "saves",
  "save",
  "bookmarks",
  "favorites",
  "favourites",
];

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();

  // ── Step 1: catch any new account-flow engagement TestOrders ──
  // The original /api/pool/reconcile-engagement marked rows up to
  // its run-time. Anything placed since (e.g. before the routing
  // fix landed) needs the same treatment.
  const toMarkIds = await prisma.testOrder.findMany({
    where: {
      status: { in: ["running", "completed", "completed_partial"] },
      testPostId: null,
      service: { serviceType: { in: ENGAGEMENT_METRICS } },
    },
    select: { id: true },
  });
  const markIds = toMarkIds.map((r) => r.id);
  const reconcileResult = markIds.length
    ? await prisma.testOrder.updateMany({
        where: { id: { in: markIds } },
        data: {
          status: "aborted_misplaced",
          abortReason: "engagement_legacy_account_baseline",
          completedAt: new Date(),
          nextPollAt: null,
        },
      })
    : { count: 0 };

  // Free up TestAccounts that were pinned by the legacy orders.
  const releasedAccounts = markIds.length
    ? await prisma.testAccount.updateMany({
        where: {
          status: "assigned",
          assignedTestOrderId: { in: markIds },
        },
        data: {
          status: "available",
          assignedAt: null,
          assignedTestOrderId: null,
          active: true,
        },
      })
    : { count: 0 };

  // ── Step 2: identify affected engagement services ──
  // Any service that has AT LEAST ONE aborted_misplaced TestOrder
  // with the legacy reason. We don't filter on serviceType again —
  // the abortReason is the canonical signal.
  const affected = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT DISTINCT s.id
    FROM "Service" s
    JOIN "TestOrder" tor ON tor."serviceId" = s.id
    WHERE tor.status = 'aborted_misplaced'
      AND tor."abortReason" = 'engagement_legacy_account_baseline'
  `;
  const affectedIds = affected.map((r) => r.id);

  // 2a. Service.active → true for any false
  const reactivated = affectedIds.length
    ? await prisma.service.updateMany({
        where: { id: { in: affectedIds }, active: false },
        data: { active: true },
      })
    : { count: 0 };

  // 2b. PSC.lifecycleStatus DEAD/PERMANENTLY_FAILED → TESTING
  const lifecycleRestored = affectedIds.length
    ? await prisma.productServiceCandidate.updateMany({
        where: {
          serviceId: { in: affectedIds },
          lifecycleStatus: { in: ["DEAD", "PERMANENTLY_FAILED"] },
        },
        data: {
          lifecycleStatus: "TESTING",
          isEligible: true,
        },
      })
    : { count: 0 };

  // 2c. PSC.currentScore → null for affected rows so the next
  // scoring tick rebuilds from real (post-flow) Measurements only.
  // We DON'T null-out reliability — the backfill already correctly
  // excluded aborted_misplaced rows, so reliabilityScore reflects
  // only legitimate data (currently null for most of the cohort).
  const scoresReset = affectedIds.length
    ? await prisma.productServiceCandidate.updateMany({
        where: {
          serviceId: { in: affectedIds },
          currentScore: { not: null },
        },
        data: { currentScore: null },
      })
    : { count: 0 };

  // 2d. Service.lastTestedAt → null for affected rows so the
  // 8h-cutoff in daily-retest doesn't lock them out of the queue.
  // The previous (broken) placement stamped lastTestedAt as recently
  // as today, which would otherwise mean services have to wait 8h
  // after the bug-test before being eligible for a real post-flow
  // retest. Wiping the stamp lets oldest-first ordering pull them
  // back in immediately. Safe because the recovery only operates on
  // services whose last test was the broken flow — a legitimate
  // recent test wouldn't be aborted_misplaced.
  const lastTestedReset = affectedIds.length
    ? await prisma.service.updateMany({
        where: { id: { in: affectedIds }, lastTestedAt: { not: null } },
        data: { lastTestedAt: null },
      })
    : { count: 0 };

  // ── Step 3: clear service_killed_no_delivery alerts ──
  const alertsResolved = affectedIds.length
    ? await prisma.alert.updateMany({
        where: {
          relatedEntityType: "service",
          relatedEntityId: { in: affectedIds },
          code: { startsWith: "service_killed_no_delivery:" },
          status: { in: ["active", "acknowledged"] },
        },
        data: { status: "resolved", resolvedAt: new Date() },
      })
    : { count: 0 };

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    misplacedMarked: reconcileResult.count,
    accountsReleased: releasedAccounts.count,
    affectedServices: affectedIds.length,
    serviceReactivated: reactivated.count,
    pscLifecycleRestored: lifecycleRestored.count,
    pscCurrentScoreReset: scoresReset.count,
    serviceLastTestedAtCleared: lastTestedReset.count,
    alertsResolved: alertsResolved.count,
    note: "Lifecycle reset to TESTING — lastTestedAt cleared so daily-retest's 8h cutoff doesn't lock affected services out of the queue. Run /api/cron/scoring after to refresh ranks.",
  });
}

export const GET = POST;
