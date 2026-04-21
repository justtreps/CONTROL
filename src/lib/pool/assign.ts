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
}: {
  platform: string;
  testOrderId: number;
}): Promise<TestAccount | null> {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.testAccount.findFirst({
      where: { platform, status: "available" },
      orderBy: { firstSeenAt: "asc" },
    });
    if (!candidate) return null;

    return tx.testAccount.update({
      where: { id: candidate.id },
      data: {
        status: "assigned",
        assignedAt: new Date(),
        assignedTestOrderId: testOrderId,
        active: false, // legacy flag — 'assigned' accounts aren't pickable as "active" for anything else
      },
    });
  });
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
