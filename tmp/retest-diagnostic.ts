import { prisma } from "../src/lib/prisma";

async function main() {
  // ── 1. SampleCount distribution on QUALIFIED services ─────
  console.log("=== 1. Distribution sampleCount sur services QUALIFIED ===");

  const RANK: Record<string, number> = {
    NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4,
    PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8
  };
  const allCands = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, string>();
  for (const c of allCands) {
    const cur = best.get(c.serviceId);
    if (!cur || RANK[c.lifecycleStatus] > RANK[cur]) best.set(c.serviceId, c.lifecycleStatus);
  }
  const qualifiedIds = Array.from(best.entries()).filter(([,s]) => s === "QUALIFIED").map(([id]) => id);
  const monitoredIds = Array.from(best.entries()).filter(([,s]) => s === "MONITORED").map(([id]) => id);
  console.log(`QUALIFIED services: ${qualifiedIds.length}`);
  console.log(`MONITORED services: ${monitoredIds.length}`);

  // For each, count completed TestOrders with delivered > 0 (RULE 1 valid samples)
  const buckets = { "n=0":0, "n=1":0, "n=2":0, "n=3":0, "n=4":0, "n=5":0, "n=6+":0 };
  const allTargetIds = [...qualifiedIds, ...monitoredIds];
  
  for (const sid of allTargetIds) {
    const orders = await prisma.testOrder.findMany({
      where: { serviceId: sid, status: "completed" },
      include: { measurements: true },
    });
    const validCount = orders.filter((o) => {
      const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
      return peak > o.baselineCount;
    }).length;
    if (validCount === 0) buckets["n=0"]++;
    else if (validCount === 1) buckets["n=1"]++;
    else if (validCount === 2) buckets["n=2"]++;
    else if (validCount === 3) buckets["n=3"]++;
    else if (validCount === 4) buckets["n=4"]++;
    else if (validCount === 5) buckets["n=5"]++;
    else buckets["n=6+"]++;
  }
  console.log(`\nDistribution sampleCount RULE-1-valides (QUALIFIED + MONITORED, ${allTargetIds.length} total):`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`);

  // Also count using ServiceScore.sampleCount (what scoring engine sees)
  const scoreSamples = await prisma.serviceScore.findMany({
    where: {
      serviceId: { in: allTargetIds },
      sampleCount: { gt: 0 },
    },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
    select: { serviceId: true, sampleCount: true },
  });
  const scoreBuckets: Record<string, number> = { "n=0":0, "n=1":0, "n=2":0, "n=3":0, "n=4":0, "n=5":0, "n=6+":0 };
  const seenScore = new Set<number>();
  for (const s of scoreSamples) {
    if (seenScore.has(s.serviceId)) continue;
    seenScore.add(s.serviceId);
    const n = s.sampleCount;
    if (n === 0) scoreBuckets["n=0"]++;
    else if (n === 1) scoreBuckets["n=1"]++;
    else if (n === 2) scoreBuckets["n=2"]++;
    else if (n === 3) scoreBuckets["n=3"]++;
    else if (n === 4) scoreBuckets["n=4"]++;
    else if (n === 5) scoreBuckets["n=5"]++;
    else scoreBuckets["n=6+"]++;
  }
  const noScore = allTargetIds.length - seenScore.size;
  console.log(`\nDistribution ServiceScore.sampleCount (latest per service):`);
  console.log(`  no ServiceScore row: ${noScore}`);
  for (const [k, v] of Object.entries(scoreBuckets)) console.log(`  ${k}: ${v}`);

  // ── 2. Cron daily-retest activity in last 24h ──────────────
  console.log("\n=== 2. Activité daily-retest cron (24h) ===");
  
  // Count TestOrders placed in last 24h, grouped by hour
  const since24h = new Date(Date.now() - 24 * 60 * 60_000);
  const recentOrders = await prisma.testOrder.findMany({
    where: { placedAt: { gte: since24h } },
    select: { placedAt: true, serviceId: true },
  });
  console.log(`Total TestOrders placés 24h: ${recentOrders.length}`);
  
  // Group by hour
  const byHour: Record<string, number> = {};
  for (const o of recentOrders) {
    const h = o.placedAt.toISOString().slice(0, 13) + ":00";
    byHour[h] = (byHour[h] ?? 0) + 1;
  }
  const sortedHours = Object.entries(byHour).sort();
  console.log(`\nPlacements par heure UTC (last 24h):`);
  for (const [h, count] of sortedHours) {
    const bar = "█".repeat(Math.min(50, Math.round(count / 5)));
    console.log(`  ${h.slice(11)} ${count.toString().padStart(4)} ${bar}`);
  }

  // How many of these came from QUALIFIED/MONITORED retest (= daily-retest cron)
  const qualifiedSet = new Set(allTargetIds);
  const retestPlacements = recentOrders.filter((o) => qualifiedSet.has(o.serviceId)).length;
  console.log(`\nDont placements sur QUALIFIED/MONITORED (= signal daily-retest): ${retestPlacements}`);

  // ── 3. Eligibility check for daily-retest cron ─────────────
  console.log("\n=== 3. Conditions d'éligibilité daily-retest ===");
  const cutoff8h = new Date(Date.now() - 8 * 60 * 60_000);
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60_000);

  // Currently the cron uses cutoff = now - 24h (line 43 of route.ts)
  const eligibleNow = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: "MONITORED", // ← ONLY MONITORED, not QUALIFIED
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: cutoff24h } }],
      },
    },
    distinct: ["serviceId"],
  });
  console.log(`Avec filtre actuel (lifecycleStatus=MONITORED, lastTestedAt<24h ago):`);
  console.log(`  Éligibles MAINTENANT: ${eligibleNow.length}`);
  
  // What if QUALIFIED were also included?
  const eligibleWithQualified = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: { in: ["MONITORED", "QUALIFIED"] },
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: cutoff24h } }],
      },
    },
    distinct: ["serviceId"],
  });
  console.log(`Si QUALIFIED inclus aussi: ${eligibleWithQualified.length}`);
  
  // What about 8h cutoff for 3x/day?
  const eligibleWithQualified8h = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: { in: ["MONITORED", "QUALIFIED"] },
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: cutoff8h } }],
      },
    },
    distinct: ["serviceId"],
  });
  console.log(`Si QUALIFIED+MONITORED + cutoff 8h: ${eligibleWithQualified8h.length}`);

  // ── 4. Cap horaire check ───────────────────────────────────
  console.log("\n=== 4. Cap horaire ===");
  // Cron cap = 200/hour
  // Theoretical 3x/day on N services = N*3/24 per hour
  const monitoredQualifiedCount = qualifiedIds.length + monitoredIds.length;
  const theoreticalRetestPerHour = (monitoredQualifiedCount * 3) / 24;
  console.log(`  ${monitoredQualifiedCount} services × 3/jour / 24h = ${theoreticalRetestPerHour.toFixed(0)} retests/heure attendus`);
  console.log(`  Cap actuel: 200/heure`);
  console.log(`  ${theoreticalRetestPerHour > 200 ? "⚠ CAP HIT" : "✓ Sous le cap"}`);

  // ── 5. Toggles state ──────────────────────────────────────
  console.log("\n=== 5. SystemToggle state ===");
  const t = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  console.log(`  testBotEnabled       : ${t?.testBotEnabled}`);
  console.log(`  dailyRetestEnabled   : ${t?.dailyRetestEnabled}`);
  console.log(`  dryRunMode           : ${t?.dryRunMode}`);

  // ── 6. Balance fails on retest attempts last 24h ──────────
  console.log("\n=== 6. Retest fails dans 24h ===");
  // TestOrders with abortReason in last 24h
  const recentAborts = await prisma.testOrder.findMany({
    where: {
      placedAt: { gte: since24h },
      OR: [
        { status: { startsWith: "aborted" } },
        { abortReason: { not: null } },
      ],
    },
    select: { id: true, serviceId: true, status: true, abortReason: true },
  });
  const balanceAborts = recentAborts.filter((o) =>
    /balance|insufficient|fund/i.test(o.abortReason ?? "")
  );
  console.log(`  Total aborted TestOrders 24h: ${recentAborts.length}`);
  console.log(`  Dont balance-related        : ${balanceAborts.length}`);

  // Service.lastPlacementError balance-related in 24h
  const balanceFails = await prisma.service.count({
    where: {
      lastPlacementErrorAt: { gte: since24h },
      lastPlacementError: { contains: "balance", mode: "insensitive" },
    },
  });
  console.log(`  Services avec lastPlacementError balance-tag 24h: ${balanceFails}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
