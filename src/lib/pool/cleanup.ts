// Pool cleanup — archive consumed / invalid rows older than 90 days.
// Rows keep existing (status='archived') for audit. A second step can
// hard-delete rows archived > 365d if we ever want to purge.

import { prisma } from "@/lib/prisma";

export type CleanupStats = {
  archived: number;
  reason: {
    consumedOver90d: number;
    invalidOver90d: number;
  };
};

export async function archiveOldRecords(): Promise<CleanupStats> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);

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
  };
}
