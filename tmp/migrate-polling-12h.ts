// Migration: seed nextPollAt on all running TestOrders so the new
// 12h-cadence poller picks them up without a spike. Setting them
// all to now + 12h means the next polling round happens once, 12h
// from now — predictable load.

import { prisma } from "../src/lib/prisma";

async function main() {
  const soon = new Date(Date.now() + 12 * 60 * 60_000);
  const running = await prisma.testOrder.count({ where: { status: "running" } });
  console.log(`Running TestOrders: ${running}`);

  // Set nextPollAt for all running rows that don't have it yet (or
  // have a stale adaptive-polling state). Don't touch rows that
  // already have a forward-looking nextPollAt — an operator who
  // hand-scheduled something shouldn't get stomped.
  const updated = await prisma.testOrder.updateMany({
    where: {
      status: "running",
      OR: [{ nextPollAt: null }, { nextPollAt: { lt: new Date() } }],
    },
    data: {
      nextPollAt: soon,
      pollingState: undefined, // keep the legacy JSON row readable
                               // but the new poller ignores it anyway
    },
  });
  console.log(`Updated ${updated.count} rows to nextPollAt=${soon.toISOString()}`);

  const confirmed = await prisma.testOrder.count({
    where: { status: "running", nextPollAt: { not: null } },
  });
  console.log(`Confirmed: ${confirmed} running orders now have nextPollAt set`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
