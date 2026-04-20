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
