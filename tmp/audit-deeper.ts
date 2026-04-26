import { prisma } from "../src/lib/prisma";

async function main() {
  // 1. Services NEW with TestOrders running but stuck
  console.log("=== 1. Services NEW avec TestOrder running (stuck en NEW au lieu de TESTING) ===");
  const newWithRunning = await prisma.productServiceCandidate.findMany({
    where: { lifecycleStatus: "NEW" },
    select: { serviceId: true },
    distinct: ["serviceId"],
  });
  let stuckCount = 0;
  for (const c of newWithRunning) {
    const hasRunning = await prisma.testOrder.count({
      where: { serviceId: c.serviceId, status: "running" },
    });
    if (hasRunning > 0) stuckCount++;
  }
  console.log(`Services en NEW avec TestOrder running: ${stuckCount}`);

  // 2. Services TESTING avec ZÉRO TestOrder running (= placement parti, mais pas de test running)
  console.log("\n=== 2. Services TESTING sans TestOrder running ===");
  const testingCands = await prisma.productServiceCandidate.findMany({
    where: { lifecycleStatus: "TESTING" },
    distinct: ["serviceId"],
    select: { serviceId: true },
  });
  let testingNoOrder = 0;
  for (const c of testingCands.slice(0, 100)) {
    const hasRunning = await prisma.testOrder.count({
      where: { serviceId: c.serviceId, status: { in: ["running", "completed"] } },
    });
    if (hasRunning === 0) testingNoOrder++;
  }
  console.log(`Sample 100 TESTING: ${testingNoOrder} sans TestOrder du tout`);

  // 3. Latest ServiceScore vs latest TestOrder per service - check for stale scores
  console.log("\n=== 3. Cohérence ServiceScore.computedAt vs latest TestOrder.completedAt ===");
  const recentlyCompleted = await prisma.testOrder.findMany({
    where: {
      status: "completed",
      completedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
    },
    select: { serviceId: true, completedAt: true },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { completedAt: "desc" }],
    take: 50,
  });
  let staleScores = 0;
  for (const o of recentlyCompleted.slice(0, 50)) {
    const latestScore = await prisma.serviceScore.findFirst({
      where: { serviceId: o.serviceId },
      orderBy: { computedAt: "desc" },
    });
    if (!latestScore || (o.completedAt && latestScore.computedAt < o.completedAt)) staleScores++;
  }
  console.log(`Recently-completed services dont ServiceScore est stale: ${staleScores}/${recentlyCompleted.length}`);

  // 4. Cron scoring fires every 10 min — last ServiceScore.computedAt should be < 11 min old
  const latestScore = await prisma.serviceScore.findFirst({
    orderBy: { computedAt: "desc" },
  });
  const ageMin = latestScore ? Math.round((Date.now() - latestScore.computedAt.getTime()) / 60_000) : -1;
  console.log(`\nDernière ServiceScore écrite il y a: ${ageMin}min (cron fires every 10min)`);

  // 5. ProductServiceCandidate.currentScore vs latest ServiceScore.weightedScore
  console.log("\n=== 5. PSC.currentScore vs latest SS.weightedScore (denorm coherence) ===");
  let denormStale = 0, denormChecked = 0;
  const allCands = await prisma.productServiceCandidate.findMany({
    where: { isEligible: true, currentScore: { not: null } },
    select: { id: true, serviceId: true, currentScore: true },
    take: 100,
  });
  for (const c of allCands) {
    const ss = await prisma.serviceScore.findFirst({
      where: { serviceId: c.serviceId },
      orderBy: { computedAt: "desc" },
    });
    if (!ss) continue;
    denormChecked++;
    if (Math.abs((c.currentScore ?? 0) - ss.weightedScore) > 0.5) denormStale++;
  }
  console.log(`Sample 100: ${denormStale}/${denormChecked} denormalised currentScore stale vs latest weightedScore`);

  // 6. PoolJob recent activity (last 6h) — pool subsystem sanity
  console.log("\n=== 6. Pool jobs activity (last 6h) ===");
  const since6h = new Date(Date.now() - 6 * 3600_000);
  const recentJobs = await prisma.poolJob.findMany({
    where: { startedAt: { gte: since6h } },
    select: { jobType: true, status: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  const jobByTypeStatus: Record<string, number> = {};
  for (const j of recentJobs) {
    const k = `${j.jobType}/${j.status}`;
    jobByTypeStatus[k] = (jobByTypeStatus[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(jobByTypeStatus)) console.log(`  ${k}: ${v}`);
  if (recentJobs.length === 0) console.log("  (no pool jobs in 6h — orchestrator may not be firing)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
