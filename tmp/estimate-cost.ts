// Pre-launch cost estimate — mirrors launchCampaign's math
// without creating a campaign row.

import { prisma } from "../src/lib/prisma";

async function main() {
  const staleCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const cands = await prisma.productServiceCandidate.findMany({
    where: {
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: staleCutoff } }],
      },
    },
    include: {
      service: {
        select: {
          id: true,
          name: true,
          platform: true,
          minQuantity: true,
          ratePerK: true,
        },
      },
    },
  });
  const seen = new Set<number>();
  const svc: Array<{
    id: number;
    name: string;
    platform: string;
    minQuantity: number;
    ratePerK: number;
    cost: number;
  }> = [];
  for (const c of cands) {
    if (!c.service || seen.has(c.service.id)) continue;
    seen.add(c.service.id);
    const cost = (c.service.ratePerK * c.service.minQuantity) / 1000;
    svc.push({ ...c.service, cost });
  }
  const total = svc.reduce((a, s) => a + s.cost, 0);
  const byPlatform: Record<string, { count: number; cost: number }> = {};
  for (const s of svc) {
    if (!byPlatform[s.platform])
      byPlatform[s.platform] = { count: 0, cost: 0 };
    byPlatform[s.platform].count++;
    byPlatform[s.platform].cost += s.cost;
  }
  console.log("═══ Campaign estimate ═══");
  console.log(`Services to test: ${svc.length}`);
  console.log(`Total estimated cost: $${total.toFixed(2)} USD`);
  console.log("Per platform:");
  for (const [p, v] of Object.entries(byPlatform)) {
    console.log(`  ${p}: ${v.count} services, $${v.cost.toFixed(2)}`);
  }
  // Highest-cost outliers
  const sorted = [...svc].sort((a, b) => b.cost - a.cost);
  console.log("\nTop 10 most expensive single tests:");
  for (const s of sorted.slice(0, 10)) {
    console.log(
      `  $${s.cost.toFixed(4)} · #${s.id} ${s.platform} min=${s.minQuantity} rate=${s.ratePerK} ${s.name.slice(0, 60)}`
    );
  }
  console.log("\nBottom 5 cheapest:");
  for (const s of sorted.slice(-5).reverse()) {
    console.log(
      `  $${s.cost.toFixed(4)} · #${s.id} ${s.platform} min=${s.minQuantity} rate=${s.ratePerK} ${s.name.slice(0, 60)}`
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
