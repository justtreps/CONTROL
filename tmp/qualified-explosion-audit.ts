import { prisma } from "../src/lib/prisma";

async function main() {
  // 1. Lifecycle counts (de-dup per service, best status wins)
  const RANK: Record<string, number> = {
    NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4,
    PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8,
  };
  const allCands = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, string>();
  for (const c of allCands) {
    const cur = best.get(c.serviceId);
    if (!cur || RANK[c.lifecycleStatus] > RANK[cur]) best.set(c.serviceId, c.lifecycleStatus);
  }
  const counts: Record<string, number> = {};
  for (const v of Array.from(best.values())) counts[v] = (counts[v] ?? 0) + 1;
  
  console.log("=== 1. Lifecycle de-duped per service ===");
  let total = 0;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`);
    total += v;
  }
  console.log(`  ${"TOTAL".padEnd(25)} ${total}`);
  console.log(`  ${"Expected (catalogue)".padEnd(25)} 3473 ${total === 3473 ? "✓" : `⚠ diff=${total - 3473}`}`);

  // Raw groupBy as well for cross-check
  console.log("\n=== Raw ProductServiceCandidate.lifecycleStatus groupBy ===");
  const raw = await prisma.productServiceCandidate.groupBy({
    by: ["lifecycleStatus"],
    _count: { id: true },
  });
  let rawTotal = 0;
  for (const r of raw) {
    console.log(`  ${r.lifecycleStatus.padEnd(25)} ${r._count.id}`);
    rawTotal += r._count.id;
  }
  console.log(`  ${"RAW TOTAL".padEnd(25)} ${rawTotal}`);

  // 2. QUALIFIED freshness
  const qualifiedIds = Array.from(best.entries()).filter(([,s]) => s === "QUALIFIED").map(([id]) => id);
  console.log(`\n=== 2. QUALIFIED freshness (n=${qualifiedIds.length}) ===`);
  
  // ProductServiceCandidate.updatedAt for those candidacies
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since1h = new Date(Date.now() - 60 * 60_000);
  
  const qualifiedRecent = await prisma.productServiceCandidate.findMany({
    where: {
      serviceId: { in: qualifiedIds },
      lifecycleStatus: "QUALIFIED",
    },
    select: { serviceId: true, updatedAt: true },
  });
  const seen = new Set<number>();
  let inLast1h = 0, inLast24h = 0, older = 0;
  for (const r of qualifiedRecent) {
    if (seen.has(r.serviceId)) continue;
    seen.add(r.serviceId);
    if (r.updatedAt >= since1h) inLast1h++;
    else if (r.updatedAt >= since24h) inLast24h++;
    else older++;
  }
  console.log(`  Updated dans 1h    : ${inLast1h}`);
  console.log(`  Updated dans 24h   : ${inLast24h}`);
  console.log(`  Plus ancien (>24h) : ${older}`);

  // 3. Distribution sampleCount on QUALIFIED via ServiceScore
  console.log(`\n=== 3. Distribution sampleCount sur QUALIFIED (latest ServiceScore) ===`);
  const scores = await prisma.serviceScore.findMany({
    where: { serviceId: { in: qualifiedIds } },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
    select: { serviceId: true, sampleCount: true, computedAt: true },
  });
  const seenScore = new Set<number>();
  const sampleBuckets: Record<string, number> = {
    "no_score":0, "n=0":0, "n=1":0, "n=2":0, "n=3":0, "n=4":0, "n=5+":0,
  };
  for (const s of scores) {
    if (seenScore.has(s.serviceId)) continue;
    seenScore.add(s.serviceId);
    const n = s.sampleCount;
    if (n === 0) sampleBuckets["n=0"]++;
    else if (n === 1) sampleBuckets["n=1"]++;
    else if (n === 2) sampleBuckets["n=2"]++;
    else if (n === 3) sampleBuckets["n=3"]++;
    else if (n === 4) sampleBuckets["n=4"]++;
    else sampleBuckets["n=5+"]++;
  }
  sampleBuckets["no_score"] = qualifiedIds.length - seenScore.size;
  for (const [k, v] of Object.entries(sampleBuckets)) console.log(`  ${k.padEnd(10)} ${v}`);

  // 4. RULE 1 verification: every QUALIFIED must have >=1 Measurement deliveredQty>0
  console.log(`\n=== 4. RULE 1 verification (QUALIFIED needs >=1 Measurement actualCount > baselineCount) ===`);
  // Pull all completed orders + measurements for qualified service IDs at once
  const orders = await prisma.testOrder.findMany({
    where: {
      serviceId: { in: qualifiedIds },
      status: "completed",
    },
    include: { measurements: true },
  });
  const everDeliveredSet = new Set<number>();
  for (const o of orders) {
    const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
    if (peak > o.baselineCount) everDeliveredSet.add(o.serviceId);
  }
  const ruleOnePass = everDeliveredSet.size;
  const ruleOneFail = qualifiedIds.length - ruleOnePass;
  console.log(`  ✓ RULE 1 valid (>=1 delivered) : ${ruleOnePass}`);
  console.log(`  ✗ RULE 1 fail   (no delivery)  : ${ruleOneFail}`);
  if (ruleOneFail > 0) {
    // Sample 5 violators
    const violatorIds = qualifiedIds.filter((id) => !everDeliveredSet.has(id)).slice(0, 5);
    console.log(`  Sample 5 violators:`);
    for (const id of violatorIds) {
      const allOrders = await prisma.testOrder.findMany({
        where: { serviceId: id },
        select: { status: true, baselineCount: true, measurements: true },
      });
      const completedCount = allOrders.filter((o) => o.status === "completed").length;
      const runningCount = allOrders.filter((o) => o.status === "running").length;
      console.log(`    svc#${id} totalOrders=${allOrders.length} completed=${completedCount} running=${runningCount}`);
    }
  }

  // 5. Today's QUALIFIED transitions — when did they happen?
  // ProductServiceCandidate.updatedAt is touched on lifecycle flip
  const todaysQualified = await prisma.productServiceCandidate.count({
    where: {
      lifecycleStatus: "QUALIFIED",
      updatedAt: { gte: since24h },
    },
  });
  console.log(`\nQualified candidacies modifiées 24h: ${todaysQualified}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
