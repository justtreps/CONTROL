import { prisma } from "../src/lib/prisma";

async function main() {
  // Latest ServiceScore rows — confirm new fields populated
  const recent = await prisma.serviceScore.findMany({
    orderBy: { computedAt: "desc" },
    take: 10,
  });
  console.log("=== 10 most recent ServiceScore rows ===");
  for (const r of recent) {
    console.log(
      `  svc#${r.serviceId} curr=${r.currentScore.toFixed(1)} raw=${r.rawScore.toFixed(1)} weighted=${r.weightedScore.toFixed(1)} n=${r.sampleCount} conf=${r.confidence.toFixed(2)} @${r.computedAt.toISOString().slice(11, 19)}`
    );
  }

  // Verify currentScore = weightedScore
  const mismatch = await prisma.serviceScore.findMany({
    where: {
      computedAt: { gte: new Date(Date.now() - 60 * 60_000) },
    },
    take: 100,
  });
  let bad = 0;
  for (const r of mismatch) {
    if (Math.abs(r.currentScore - r.weightedScore) > 0.01) bad++;
  }
  console.log(`\ncurrentScore vs weightedScore mismatch (last 1h, sample ${mismatch.length}): ${bad}`);

  // Recent campaigns / brute campaigns - are they processing or stuck?
  const campaigns = await prisma.scoringCampaign.findMany({
    where: { status: { in: ["running", "paused", "paused_for_pool_cleanup"] } },
  });
  console.log(`\n=== Active scoring campaigns ===`);
  for (const c of campaigns) {
    const remaining = c.targetServiceIds.length - c.placedServiceIds.length;
    const ageH = Math.round((Date.now() - c.startedAt.getTime()) / 3600_000);
    console.log(`  campaign#${c.id} status=${c.status} stop=${c.stopReason ?? "-"} âge=${ageH}h placed=${c.placedCount}/${c.targetServiceIds.length} remaining=${remaining}`);
  }

  // BalanceRetry budget right now
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const balanceFails = await prisma.service.count({
    where: { lastPlacementErrorAt: { gte: since24h } },
  });
  console.log(`\n=== Balance retry card (services avec lastPlacementError 24h) ===`);
  console.log(`  Total: ${balanceFails}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
