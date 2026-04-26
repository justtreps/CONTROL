import { prisma } from "../src/lib/prisma";
import { readFileSync } from "fs";

async function main() {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  console.log("=== CRONS dans vercel.json ===");
  for (const c of vercel.crons) {
    console.log(`  ${c.schedule.padEnd(15)} ${c.path}`);
  }

  // For each cron, check actual fire history via downstream effects
  console.log("\n=== Activité 1h dernière ===");
  const since1h = new Date(Date.now() - 60 * 60_000);
  
  // Pool jobs (proxy for orchestrator/scrape/health-check crons)
  const recentPoolJobs = await prisma.poolJob.findMany({
    where: { startedAt: { gte: since1h } },
    select: { jobType: true, status: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  const byType: Record<string, number> = {};
  for (const j of recentPoolJobs) byType[j.jobType] = (byType[j.jobType] ?? 0) + 1;
  console.log(`PoolJobs créés 1h dernière:`);
  for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v}`);

  // TestOrders (proxy for testbot-poll, daily-retest, brute-campaign-runner)
  const recentTOs = await prisma.testOrder.count({ where: { placedAt: { gte: since1h } } });
  console.log(`TestOrders placés 1h: ${recentTOs}`);

  // ScoringCampaigns (proxy for scoring-campaign-runner / brute-campaign-runner)
  const recentCampaigns = await prisma.scoringCampaign.findMany({
    where: { OR: [{ startedAt: { gte: since1h } }, { updatedAt: { gte: since1h } }] },
    orderBy: { id: "desc" },
  });
  console.log(`Campaigns active/updated 1h: ${recentCampaigns.length}`);
  for (const c of recentCampaigns) {
    console.log(`  campaign#${c.id} status=${c.status} stop=${c.stopReason ?? "-"} placed=${c.placedCount} target=${c.targetServiceIds.length}`);
  }

  // Alerts engine activity
  const recentAlerts = await prisma.alert.findMany({
    where: { lastTriggeredAt: { gte: since1h } },
    select: { code: true, status: true, severity: true, triggerCount: true },
    orderBy: { lastTriggeredAt: "desc" },
  });
  console.log(`\nAlertes triggered 1h: ${recentAlerts.length}`);
  for (const a of recentAlerts.slice(0, 10)) {
    console.log(`  [${a.severity}] ${a.code} status=${a.status} count=${a.triggerCount}`);
  }

  // Pool toggles vs cron expectations
  console.log("\n=== Toggles vs crons ===");
  const t = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  console.log(JSON.stringify(t, null, 2));

  // Stale campaigns (running for > 24h)
  console.log("\n=== Campagnes pausées/abandonnées ===");
  const oldCampaigns = await prisma.scoringCampaign.findMany({
    where: {
      status: { in: ["running", "paused", "paused_for_pool_cleanup"] },
      startedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) },
    },
  });
  for (const c of oldCampaigns) {
    const ageH = Math.floor((Date.now() - c.startedAt.getTime()) / 3600_000);
    console.log(`  campaign#${c.id} status=${c.status} stop=${c.stopReason ?? "-"} âge=${ageH}h placed=${c.placedCount}/${c.targetServiceIds.length}`);
  }

  // Pool counts
  const acctActive = await prisma.testAccount.count({ where: { platform: "instagram", status: "available", active: true } });
  const acctTotal = await prisma.testAccount.count({ where: { platform: "instagram" } });
  const postsAvail = await prisma.testPost.count({ where: { platform: "instagram", status: "available" } });
  console.log("\n=== Pool IG ===");
  console.log(`  Accounts available + active: ${acctActive} / ${acctTotal}`);
  console.log(`  Posts available: ${postsAvail}`);

  const ttAcct = await prisma.testAccount.count({ where: { platform: "tiktok", status: "available", active: true } });
  console.log(`  TT Accounts available + active: ${ttAcct}`);

  // RapidAPI keys
  const keys = await prisma.rapidApiKey.findMany();
  console.log("\n=== RapidAPI keys ===");
  for (const k of keys) {
    const pct = k.quotaMonthly ? ((k.quotaUsed / k.quotaMonthly) * 100).toFixed(1) : "?";
    console.log(`  #${k.id} ${k.label} status=${k.status} usage=${pct}% (${k.quotaUsed}/${k.quotaMonthly})`);
  }

  // Active alerts (not auto-resolved)
  const activeAlerts = await prisma.alert.count({
    where: { status: { in: ["active", "acknowledged"] } },
  });
  const oldAlerts = await prisma.alert.findMany({
    where: { triggerCount: { gt: 200 }, status: { in: ["active", "acknowledged"] } },
    select: { code: true, triggerCount: true, severity: true },
  });
  console.log("\n=== Alertes ===");
  console.log(`  Active total: ${activeAlerts}`);
  console.log(`  Spam (>200 triggers): ${oldAlerts.length}`);
  for (const a of oldAlerts) {
    console.log(`    [${a.severity}] ${a.code} count=${a.triggerCount}`);
  }

  // Lifecycle counts vs ProductServiceCandidate raw groupings
  console.log("\n=== Lifecycle dashboard vs raw ===");
  const groupRaw = await prisma.productServiceCandidate.groupBy({
    by: ["lifecycleStatus"],
    _count: { id: true },
  });
  console.log("Raw groupBy:");
  for (const r of groupRaw) console.log(`  ${r.lifecycleStatus}: ${r._count.id}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
