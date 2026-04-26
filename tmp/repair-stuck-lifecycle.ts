import { prisma } from "../src/lib/prisma";

async function main() {
  // 1. Services en NEW avec TestOrder running → flip NEW → TESTING
  const newWithRunning = await prisma.testOrder.findMany({
    where: { status: "running" },
    select: { serviceId: true },
    distinct: ["serviceId"],
  });
  const idsWithRunning = newWithRunning.map((o) => o.serviceId);
  
  const stuck = await prisma.productServiceCandidate.findMany({
    where: { serviceId: { in: idsWithRunning }, lifecycleStatus: "NEW" },
    select: { id: true, serviceId: true },
  });
  if (stuck.length > 0) {
    const r = await prisma.productServiceCandidate.updateMany({
      where: { id: { in: stuck.map((s) => s.id) } },
      data: { lifecycleStatus: "TESTING" },
    });
    console.log(`[fix-1] ${r.count} candidacies NEW→TESTING (placement déjà parti)`);
  } else {
    console.log("[fix-1] aucun NEW stuck à reflip");
  }

  // 2. Services en TESTING sans aucun TestOrder → reset NEW
  const testingCands = await prisma.productServiceCandidate.findMany({
    where: { lifecycleStatus: "TESTING" },
    select: { id: true, serviceId: true },
  });
  const orphanIds: number[] = [];
  // Bulk check all serviceIds at once to avoid N+1 queries
  const serviceIdsTesting = Array.from(new Set(testingCands.map((c) => c.serviceId)));
  const ordersGrouped = await prisma.testOrder.groupBy({
    by: ["serviceId"],
    where: { serviceId: { in: serviceIdsTesting } },
    _count: { id: true },
  });
  const hasOrdersSet = new Set(ordersGrouped.map((g) => g.serviceId));
  for (const c of testingCands) {
    if (!hasOrdersSet.has(c.serviceId)) orphanIds.push(c.id);
  }
  if (orphanIds.length > 0) {
    const r = await prisma.productServiceCandidate.updateMany({
      where: { id: { in: orphanIds } },
      data: { lifecycleStatus: "NEW" },
    });
    console.log(`[fix-2] ${r.count} candidacies TESTING→NEW (orphelins sans TestOrder, doivent être re-placés)`);
  } else {
    console.log("[fix-2] aucun TESTING orphelin");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
