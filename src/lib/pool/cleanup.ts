// Pool cleanup — archive consumed / invalid rows older than 90 days.
// Rows keep existing (status='archived') for audit. A second step can
// hard-delete rows archived > 365d if we ever want to purge.
//
// Also runs a defensive pass to flip any remaining 'assigned' rows to
// 'consumed' when the test has progressed or timed out. The scoring
// cron does this every 10 min — this is a weekly backstop.

import { prisma } from "@/lib/prisma";
import { consumeCompletedAssignments } from "./assign";

export type CleanupStats = {
  archived: number;
  reason: {
    consumedOver90d: number;
    invalidOver90d: number;
  };
  consumedAssignments: {
    byMeasurement: number;
    byTimeout: number;
  };
};

export async function archiveOldRecords(): Promise<CleanupStats> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);

  const consumedAssignments = await consumeCompletedAssignments();

  const consumedRes = await prisma.testAccount.updateMany({
    where: {
      status: "consumed",
      consumedAt: { lte: cutoff, not: null },
    },
    data: { status: "archived" },
  });

  const invalidRes = await prisma.testAccount.updateMany({
    where: {
      status: "invalid",
      invalidatedAt: { lte: cutoff, not: null },
    },
    data: { status: "archived" },
  });

  return {
    archived: consumedRes.count + invalidRes.count,
    reason: {
      consumedOver90d: consumedRes.count,
      invalidOver90d: invalidRes.count,
    },
    consumedAssignments,
  };
}
