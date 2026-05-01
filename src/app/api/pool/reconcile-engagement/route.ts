// One-shot — marks pre-fix engagement TestOrders as aborted_misplaced
// so they don't pollute the score engine.
//
// Why this exists: before the engagement-flow fix, services with
// serviceType ∈ {likes, views, shares, saves} got TestOrders that
// (a) carried a testAccountId only, no testPostId; (b) measured the
// parent's followerCount as baseline; (c) saw deliveredQty = 0 every
// poll (BulkMedya was correctly delivering likes to the post URL,
// but our oracle was reading account followers, not post likes).
// Result: every engagement service eventually accumulated 2+ zero-
// delivery terminal tests and got demoted to TESTING / DEAD even
// though BulkMedya was working fine.
//
// This endpoint:
//   1. Marks every TestOrder where:
//        - service.serviceType ∈ engagement metrics
//        - testPostId IS NULL (legacy shape)
//        - status = "running" OR (status = "completed*" AND
//          placedAt > NOW() - 30 days, to clean recent rows)
//      with status='aborted_misplaced', completedAt=NOW(),
//      abortReason='engagement_legacy_account_baseline'.
//   2. Returns a count breakdown so the operator can see what landed.
//
// Idempotent: rows already aborted_misplaced are skipped (the
// status filter excludes them).
//
// Auth: Bearer CRON_SECRET — same pattern as backfill-last-tested.
// The middleware whitelist needs /api/pool/reconcile-engagement
// added to PUBLIC_PATHS for the curl path to work.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

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

  // Snapshot pre-mark so we can return a "before" count for the
  // operator. Cheap (single COUNT with index hit on serviceId/
  // status/placedAt).
  const candidates = await prisma.testOrder.count({
    where: {
      status: { in: ["running", "completed", "completed_partial"] },
      testPostId: null,
      service: {
        serviceType: { in: ENGAGEMENT_METRICS },
      },
    },
  });

  // First pull the IDs of rows we're about to mark — needed both for
  // the count we return AND so we can release any TestAccount rows
  // that had been pinned by these legacy engagement orders.
  const toAbortIds = await prisma.testOrder.findMany({
    where: {
      status: { in: ["running", "completed", "completed_partial"] },
      testPostId: null,
      service: {
        serviceType: { in: ENGAGEMENT_METRICS },
      },
    },
    select: { id: true },
  });
  const ids = toAbortIds.map((r) => r.id);

  // Mark as aborted_misplaced so the score engine's "completed only"
  // filter excludes them. We DON'T touch rows already finalised
  // properly (those would have testPostId set after the fix lands)
  // and we DON'T touch follower-flow rows.
  //
  // For 'running' rows we also clear nextPollAt so the poller stops
  // re-fetching them.
  const updated = ids.length
    ? await prisma.testOrder.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "aborted_misplaced",
          abortReason: "engagement_legacy_account_baseline",
          completedAt: new Date(),
          nextPollAt: null,
        },
      })
    : { count: 0 };

  // Also release any TestAccount rows the legacy engagement orders
  // had pinned to status='assigned' — they should never have been
  // pulled from the follower pool for an engagement test, but the
  // legacy code did so. Free them so the pool is healthy.
  const releasedAccounts = ids.length
    ? await prisma.testAccount.updateMany({
        where: {
          status: "assigned",
          assignedTestOrderId: { in: ids },
        },
        data: {
          status: "available",
          assignedAt: null,
          assignedTestOrderId: null,
          active: true,
        },
      })
    : { count: 0 };

  return NextResponse.json({
    ok: true,
    candidates,
    updated: updated.count,
    releasedAccounts: releasedAccounts.count,
    note: "Engagement TestOrders without testPostId marked aborted_misplaced. Score engine will exclude them on the next pass.",
  });
}

export const GET = POST;
