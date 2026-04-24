// One-shot reconciliation: first tick timed out, 8 TestOrder were
// created in DB but campaign.placedServiceIds wasn't updated. Pull
// the actual TestOrders placed since campaign start + add their
// serviceIds to placedServiceIds so the next tick doesn't re-place.

import { prisma } from "../src/lib/prisma";

async function main() {
  const c = await prisma.scoringCampaign.findUnique({ where: { id: 1 } });
  if (!c) {
    console.log("no campaign #1");
    return;
  }
  const since = c.startedAt;
  const placedOrders = await prisma.testOrder.findMany({
    where: {
      placedAt: { gte: since },
      serviceId: { in: c.targetServiceIds },
    },
    select: { serviceId: true, id: true, placedAt: true },
  });
  const ids = Array.from(new Set(placedOrders.map((o) => o.serviceId)));
  console.log(
    `campaign#1: start=${since.toISOString()} actual-placed=${placedOrders.length} distinct-services=${ids.length} row-placedCount=${c.placedCount} row-placedServiceIds=${c.placedServiceIds.length}`
  );
  await prisma.scoringCampaign.update({
    where: { id: 1 },
    data: {
      placedServiceIds: ids,
      placedCount: placedOrders.length,
    },
  });
  console.log("reconciled");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
