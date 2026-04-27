import { prisma } from "../src/lib/prisma";

async function main() {
  const now = new Date();
  const since48h = new Date(Date.now() - 48 * 3600_000);
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const since1h = new Date(Date.now() - 60 * 60_000);

  // 1. TestOrder placements 48h, par heure
  console.log("=== 1. Placements 48h par heure UTC ===");
  const recentTOs = await prisma.testOrder.findMany({
    where: { placedAt: { gte: since48h } },
    select: { id: true, placedAt: true, dryRun: true, status: true, serviceId: true, baselineCount: true, targetQuantity: true },
  });
  console.log(`Total 48h: ${recentTOs.length}`);
  const byHour: Record<string, number> = {};
  for (const o of recentTOs) {
    const h = o.placedAt.toISOString().slice(0, 13) + ":00";
    byHour[h] = (byHour[h] ?? 0) + 1;
  }
  const sorted = Object.entries(byHour).sort();
  console.log(`From ${sorted[0]?.[0] ?? "?"} to ${sorted[sorted.length-1]?.[0] ?? "?"}`);
  for (const [h, count] of sorted) {
    const bar = "█".repeat(Math.min(60, Math.round(count / 5)));
    console.log(`  ${h.slice(0, 16)} ${count.toString().padStart(4)} ${bar}`);
  }
  
  const last1hCount = recentTOs.filter((o) => o.placedAt >= since1h).length;
  const last24hCount = recentTOs.filter((o) => o.placedAt >= since24h).length;
  console.log(`\n  Last 1h:  ${last1hCount}`);
  console.log(`  Last 24h: ${last24hCount}`);
  console.log(`  Last 48h: ${recentTOs.length}`);
  
  // dryRun split
  const dryCount = recentTOs.filter((o) => o.dryRun).length;
  console.log(`\n  dryRun=true (sim): ${dryCount}`);
  console.log(`  dryRun=false (live): ${recentTOs.length - dryCount}`);

  // 2. Toggle states
  const t = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  console.log(`\n=== 2. Toggles ===`);
  console.log(JSON.stringify(t, null, 2));

  // 3. Active campaigns
  const campaigns = await prisma.scoringCampaign.findMany({
    where: { status: { in: ["running", "paused", "paused_for_pool_cleanup"] } },
    orderBy: { id: "desc" },
  });
  console.log(`\n=== 3. Active campaigns ===`);
  for (const c of campaigns) {
    const ageH = Math.round((Date.now() - c.startedAt.getTime()) / 3600_000);
    console.log(`  campaign#${c.id} status=${c.status} stop=${c.stopReason ?? "-"} placed=${c.placedCount}/${c.targetServiceIds.length} ageH=${ageH}`);
  }

  // 4. Distribution lastHealthCheckAt for running TestOrders (= dernier poll)
  console.log(`\n=== 4. Poll freshness (running TestOrders) ===`);
  const running = await prisma.testOrder.findMany({
    where: { status: "running" },
    select: { id: true, lastHealthCheckAt: true, placedAt: true, nextPollAt: true },
  });
  console.log(`Total running: ${running.length}`);
  const buckets = { "<1h":0, "1-6h":0, "6-12h":0, "12-24h":0, "24-48h":0, ">48h":0, "never":0 };
  for (const o of running) {
    if (!o.lastHealthCheckAt) { buckets["never"]++; continue; }
    const ageH = (Date.now() - o.lastHealthCheckAt.getTime()) / 3600_000;
    if (ageH < 1) buckets["<1h"]++;
    else if (ageH < 6) buckets["1-6h"]++;
    else if (ageH < 12) buckets["6-12h"]++;
    else if (ageH < 24) buckets["12-24h"]++;
    else if (ageH < 48) buckets["24-48h"]++;
    else buckets[">48h"]++;
  }
  for (const [k, v] of Object.entries(buckets)) console.log(`  lastHealthCheckAt ${k}: ${v}`);

  // nextPollAt distribution
  console.log(`\nnextPollAt distribution:`);
  const nextBuckets = { "due":0, "<1h":0, "1-6h":0, "6-12h":0, ">12h":0, "null":0 };
  for (const o of running) {
    if (!o.nextPollAt) { nextBuckets["null"]++; continue; }
    const dueIn = (o.nextPollAt.getTime() - Date.now()) / 3600_000;
    if (dueIn <= 0) nextBuckets["due"]++;
    else if (dueIn < 1) nextBuckets["<1h"]++;
    else if (dueIn < 6) nextBuckets["1-6h"]++;
    else if (dueIn < 12) nextBuckets["6-12h"]++;
    else nextBuckets[">12h"]++;
  }
  for (const [k, v] of Object.entries(nextBuckets)) console.log(`  ${k}: ${v}`);

  // 5. Top 20 services by weightedScore — ranking integrity
  console.log(`\n=== 5. Top 20 ranking integrity ===`);
  const allLatest = await prisma.serviceScore.findMany({
    where: { sampleCount: { gt: 0 } },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
  });
  const sortedDesc = [...allLatest].sort((a, b) => b.currentScore - a.currentScore);
  console.log(`Total scored: ${sortedDesc.length}`);
  for (let i = 0; i < Math.min(20, sortedDesc.length); i++) {
    const s = sortedDesc[i];
    console.log(`  #${(i+1).toString().padStart(2)} svc#${s.serviceId} weighted=${s.currentScore.toFixed(2)} raw=${s.rawScore.toFixed(2)} n=${s.sampleCount} computedAt=${s.computedAt.toISOString().slice(11, 19)}`);
  }

  // Check ranking integrity: any out-of-order pair?
  let rankingBugs = 0;
  for (let i = 1; i < sortedDesc.length; i++) {
    if (sortedDesc[i].currentScore > sortedDesc[i-1].currentScore + 0.001) {
      rankingBugs++;
      console.log(`  ⚠ RANK INVERSION: #${i} (${sortedDesc[i].currentScore}) > #${i-1} (${sortedDesc[i-1].currentScore})`);
    }
  }
  console.log(`  Ranking inversions: ${rankingBugs}`);

  // 6. Manual scoring formula recompute on 10 random qualified
  console.log(`\n=== 6. Manual formula verification (10 samples) ===`);
  const sample = sortedDesc.slice(0, 10);
  for (const s of sample) {
    // Manual recomputation: pull orders + measurements, recompute
    const orders = await prisma.testOrder.findMany({
      where: { serviceId: s.serviceId, status: "completed" },
      include: { measurements: true },
      orderBy: { placedAt: "desc" },
      take: 30,
    });
    const validOrders = orders.filter((o) => {
      const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
      return peak > o.baselineCount;
    });
    if (validOrders.length === 0) {
      console.log(`  svc#${s.serviceId} weighted=${s.currentScore.toFixed(1)} ⚠ NO RULE-1-VALID orders found in DB`);
      continue;
    }
    
    // For each order, compute completion, speed bracket, drop
    let totalRaw = 0;
    for (const o of validOrders) {
      const ms = [...o.measurements].sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
      const post = ms.filter((m) => m.checkpoint !== "T+0");
      const peak = Math.max(o.baselineCount, ...ms.map((m) => m.actualCount));
      const delivered = Math.max(0, peak - o.baselineCount);
      const completionPct = Math.min(1, delivered / Math.max(1, o.targetQuantity));
      const fiftyTarget = o.baselineCount + o.targetQuantity * 0.5;
      const fifty = post.find((m) => m.actualCount >= fiftyTarget);
      const t50 = fifty ? (fifty.checkedAt.getTime() - o.placedAt.getTime()) / 60_000 : null;
      let speedPts = 0;
      if (t50 !== null) {
        if (t50 <= 60) speedPts = 50;
        else if (t50 <= 180) speedPts = 40;
        else if (t50 <= 360) speedPts = 30;
        else if (t50 <= 720) speedPts = 20;
        else if (t50 <= 1440) speedPts = 10;
        else if (t50 <= 2880) speedPts = 5;
      }
      // Drop calc
      const last = post.length > 0 ? post[post.length-1] : null;
      let dropPct = 0;
      if (last && peak > o.baselineCount) {
        const netPeak = peak - o.baselineCount;
        const netLast = Math.max(0, last.actualCount - o.baselineCount);
        dropPct = Math.min(1, Math.max(0, (netPeak - netLast) / netPeak));
      }
      let dropPts = 0;
      if (dropPct <= 0) dropPts = 5;
      else if (dropPct < 0.10) dropPts = 4;
      else if (dropPct < 0.30) dropPts = 2;
      const orderRaw = completionPct * 30 + speedPts + dropPts; // missing cost — calculated server-side
      totalRaw += orderRaw;
    }
    const expectedRawNoCost = totalRaw / validOrders.length;
    
    console.log(`  svc#${s.serviceId} n=${s.sampleCount} expected_raw_no_cost~${expectedRawNoCost.toFixed(1)} actual_raw=${s.rawScore.toFixed(1)} diff=${(s.rawScore - expectedRawNoCost).toFixed(1)} (cost component)`);
  }

  // 7. Recent ServiceScore writes - is the cron firing?
  const lastScore = await prisma.serviceScore.findFirst({
    orderBy: { computedAt: "desc" },
  });
  console.log(`\n=== 7. Last ServiceScore ===`);
  console.log(`  computedAt: ${lastScore?.computedAt.toISOString()} (${Math.round((Date.now() - (lastScore?.computedAt.getTime() ?? 0)) / 60_000)}min ago)`);

  // 8. RECENT alerts
  const recentAlerts = await prisma.alert.findMany({
    where: { lastTriggeredAt: { gte: since1h } },
    select: { code: true, severity: true, status: true, triggerCount: true, lastTriggeredAt: true },
    orderBy: { lastTriggeredAt: "desc" },
    take: 15,
  });
  console.log(`\n=== 8. Alerts triggered last 1h: ${recentAlerts.length} ===`);
  for (const a of recentAlerts) {
    console.log(`  [${a.severity}] ${a.code} status=${a.status} count=${a.triggerCount}`);
  }

  // 9. Pool jobs activity 24h
  const recentJobs = await prisma.poolJob.findMany({
    where: { startedAt: { gte: since24h } },
    select: { jobType: true, status: true, startedAt: true },
  });
  console.log(`\n=== 9. Pool jobs 24h: ${recentJobs.length} ===`);
  const byTypeStatus: Record<string, number> = {};
  for (const j of recentJobs) {
    const k = `${j.jobType}/${j.status}`;
    byTypeStatus[k] = (byTypeStatus[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(byTypeStatus)) console.log(`  ${k}: ${v}`);

  // 10. Scoring engine recent runs (no direct table — infer via ServiceScore writes per minute)
  const lastHourScores = await prisma.serviceScore.count({
    where: { computedAt: { gte: since1h } },
  });
  const last10minScores = await prisma.serviceScore.count({
    where: { computedAt: { gte: new Date(Date.now() - 10 * 60_000) } },
  });
  console.log(`\n=== 10. ServiceScore writes ===`);
  console.log(`  Last 10min: ${last10minScores}`);
  console.log(`  Last 1h: ${lastHourScores}`);

  // 11. CatalogueSyncRun history (when did health-check last fire?)
  const lastSync = await prisma.catalogueSyncRun.findFirst({
    orderBy: { startedAt: "desc" },
  });
  console.log(`\n=== 11. CatalogueSyncRun ===`);
  if (lastSync) {
    const ageH = Math.round((Date.now() - lastSync.startedAt.getTime()) / 3600_000);
    console.log(`  Last run #${lastSync.id} status=${lastSync.status} ageH=${ageH} duration=${(((lastSync.finishedAt?.getTime() ?? Date.now()) - lastSync.startedAt.getTime()) / 1000).toFixed(0)}s`);
  } else {
    console.log("  Aucun run.");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
