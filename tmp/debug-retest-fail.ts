import { prisma } from "../src/lib/prisma";

async function main() {
  // Dernières 30 min de TestOrders créés
  const since = new Date(Date.now() - 30 * 60_000);
  const recentOrders = await prisma.testOrder.findMany({
    where: { placedAt: { gte: since } },
    select: { id: true, serviceId: true, status: true, placedAt: true, abortReason: true },
  });
  console.log(`TestOrders créés dernières 30 min: ${recentOrders.length}`);
  
  // Sample services from MONITORED/QUALIFIED that should have been retested
  const eligible = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: { in: ["QUALIFIED", "MONITORED"] },
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: new Date(Date.now() - 8 * 3600_000) } }],
      },
    },
    distinct: ["serviceId"],
    take: 5,
    include: { service: true },
  });
  console.log(`\n5 sample éligibles:`);
  for (const c of eligible) {
    if (!c.service) continue;
    console.log(`  svc#${c.service.id} platform=${c.service.platform} type=${c.service.serviceType} poolType=${c.service.poolType} lastTested=${c.service.lastTestedAt?.toISOString().slice(0, 19) ?? "never"}`);
  }
  
  // Pool availability for each platform/poolType
  const accounts = await prisma.testAccount.groupBy({
    by: ["platform", "accountType", "status"],
    _count: { id: true },
  });
  console.log(`\nTestAccount distribution:`);
  for (const r of accounts.sort((a, b) => b._count.id - a._count.id)) {
    console.log(`  ${r.platform}/${r.accountType}/${r.status}: ${r._count.id}`);
  }
  
  const posts = await prisma.testPost.groupBy({
    by: ["platform", "status"],
    _count: { id: true },
  });
  console.log(`\nTestPost distribution:`);
  for (const r of posts.sort((a, b) => b._count.id - a._count.id)) {
    console.log(`  ${r.platform}/${r.status}: ${r._count.id}`);
  }
  
  // Try manual placement on the first eligible
  if (eligible.length > 0) {
    const svc = eligible[0].service!;
    console.log(`\n=== Tentative manuelle attemptPlaceOrder svc#${svc.id} ===`);
    const { attemptPlaceOrder } = await import("../src/lib/testbot");
    try {
      const outcome = await attemptPlaceOrder({ service: svc, simulated: false });
      console.log(`  Outcome: ${JSON.stringify(outcome)}`);
    } catch (e) {
      console.log(`  THREW: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
