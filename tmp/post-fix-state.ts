import { prisma } from "../src/lib/prisma";

async function main() {
  const since30min = new Date(Date.now() - 30 * 60_000);
  
  const recentTOs = await prisma.testOrder.count({
    where: { placedAt: { gte: since30min } },
  });
  console.log(`TestOrders placés dernières 30 min: ${recentTOs}`);

  // Brute campaigns active
  const brute = await prisma.scoringCampaign.findMany({
    where: { stopReason: "brute_mode", status: { in: ["running", "paused"] } },
    orderBy: { id: "desc" },
    take: 5,
  });
  console.log(`\nBrute campaigns actives: ${brute.length}`);
  for (const c of brute) {
    const remaining = c.targetServiceIds.length - c.placedServiceIds.length;
    console.log(`  campaign#${c.id} status=${c.status} placed=${c.placedCount}/${c.targetServiceIds.length} remaining=${remaining}`);
  }

  // Lifecycle counts
  const RANK: Record<string, number> = {NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4, PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8};
  const all = await prisma.productServiceCandidate.findMany({ select: { serviceId: true, lifecycleStatus: true } });
  const best = new Map<number, string>();
  for (const c of all) {
    const cur = best.get(c.serviceId);
    if (!cur || RANK[c.lifecycleStatus] > RANK[cur]) best.set(c.serviceId, c.lifecycleStatus);
  }
  const counts: Record<string, number> = {};
  for (const v of Array.from(best.values())) counts[v] = (counts[v] ?? 0) + 1;
  console.log(`\nLifecycle counts:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`);
  }

  // Balance card status
  const balanceFails = await prisma.service.count({
    where: {
      lastPlacementErrorAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      lastPlacementError: { contains: "balance", mode: "insensitive" },
    },
  });
  console.log(`\nBalance retry card: ${balanceFails} services en attente`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
