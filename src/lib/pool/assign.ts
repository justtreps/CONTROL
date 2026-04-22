// Atomic pick-and-assign + consume helpers for the test account pool.
//
// Rule: one account = one test for its entire lifetime. pickAndAssignAccount
// runs inside a Prisma $transaction so two concurrent callers never flip
// the same row from 'available' to 'assigned'. The test-bot also keeps its
// old ad-hoc accounts as a fallback — see lib/testbot.ts.

import { prisma } from "@/lib/prisma";
import type { TestAccount } from "@prisma/client";

export async function pickAndAssignAccount({
  platform,
  testOrderId,
  accountType,
  targetCountry,
  minCountryConfidence,
}: {
  platform: string;
  testOrderId: number;
  // When omitted, we pick ANY accountType (backward-compat: the old
  // testbot call sites didn't pass this and got whatever was next in
  // the FIFO queue — which in practice was always follower_test since
  // engagement_test accounts didn't exist yet).
  accountType?: "follower_test" | "engagement_test";
  // Optional ISO-2 country — when set, we first try to pick an
  // account whose detectedCountry matches AND whose confidence is
  // at least minCountryConfidence (default 'medium'). If none, we
  // fall back to a country-less pick so the test still runs (just
  // without a geo match).
  targetCountry?: string | null;
  minCountryConfidence?: "high" | "medium" | "low" | "unknown";
}): Promise<TestAccount | null> {
  const minConf = minCountryConfidence ?? "medium";
  // Confidence enum order — higher index = stronger signal. We match
  // a row if its confidence appears at or after `minConf` in this list.
  const confOrder = ["unknown", "low", "medium", "high"];
  const minConfIdx = confOrder.indexOf(minConf);
  const acceptableConfs = confOrder.slice(minConfIdx);

  return prisma.$transaction(async (tx) => {
    const baseWhere = {
      platform,
      status: "available",
      ...(accountType ? { accountType } : {}),
    };

    // 1st try: exact country match with acceptable confidence.
    let candidate = null;
    if (targetCountry) {
      candidate = await tx.testAccount.findFirst({
        where: {
          ...baseWhere,
          detectedCountry: targetCountry,
          countryConfidence: { in: acceptableConfs },
        },
        orderBy: { firstSeenAt: "asc" },
      });
    }
    // 2nd try: no country filter (global service OR couldn't match).
    if (!candidate) {
      candidate = await tx.testAccount.findFirst({
        where: baseWhere,
        orderBy: { firstSeenAt: "asc" },
      });
    }
    if (!candidate) return null;

    return tx.testAccount.update({
      where: { id: candidate.id },
      data: {
        status: "assigned",
        assignedAt: new Date(),
        assignedTestOrderId: testOrderId,
        active: false,
      },
    });
  });
}

// For engagement_test accounts: pick one of their active media rows
// at random so the testbot can point BulkMedya at a specific post
// URL. Returns null if the account has no active posts (testbot
// should treat the assignment as failed and release the account).
export async function pickRandomActivePost(
  testAccountId: number
): Promise<{ id: number; mediaUrl: string; mediaId: string } | null> {
  const rows = await prisma.testAccountMedia.findMany({
    where: { testAccountId, status: "active" },
    select: { id: true, mediaUrl: true, mediaId: true },
  });
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

export async function consumeAccount(testAccountId: number): Promise<void> {
  await prisma.testAccount.update({
    where: { id: testAccountId },
    data: {
      status: "consumed",
      consumedAt: new Date(),
    },
  });
}

export async function invalidateAccount(
  testAccountId: number,
  reason: string
): Promise<void> {
  await prisma.testAccount.update({
    where: { id: testAccountId },
    data: {
      status: "invalid",
      invalidReason: reason,
      invalidatedAt: new Date(),
      active: false,
    },
  });
}

// Flip assigned accounts to 'consumed' once the test has progressed.
// Two signals count as "test is done":
//   1. TestOrder has ≥1 measurement past T+0 (actual data collected)
//   2. assignedAt older than 48h (safety net — measurement bot may
//      have failed, but the account is stuck; we don't want it to
//      stay assigned forever)
//
// Idempotent — accounts already consumed are filtered out by the
// initial `status='assigned'` query. Called from the scoring cron
// (every 10 min) and from the weekly cleanup cron as a backup.
export async function consumeCompletedAssignments(): Promise<{
  byMeasurement: number;
  byTimeout: number;
}> {
  const stuckDeadline = new Date(Date.now() - 48 * 3600 * 1000);

  const assigned = await prisma.testAccount.findMany({
    where: {
      status: "assigned",
      assignedTestOrderId: { not: null },
    },
    select: {
      id: true,
      assignedTestOrderId: true,
      assignedAt: true,
    },
  });

  let byMeasurement = 0;
  let byTimeout = 0;

  for (const a of assigned) {
    // Primary signal: the test has real data beyond the baseline.
    const postBaselineCount = await prisma.measurement.count({
      where: {
        testOrderId: a.assignedTestOrderId!,
        checkpoint: { not: "T+0" },
      },
    });
    if (postBaselineCount > 0) {
      await consumeAccount(a.id);
      byMeasurement++;
      continue;
    }
    // Fallback: stuck for 48h+ with nothing but the placement baseline.
    if (a.assignedAt && a.assignedAt < stuckDeadline) {
      await consumeAccount(a.id);
      byTimeout++;
    }
  }

  return { byMeasurement, byTimeout };
}
