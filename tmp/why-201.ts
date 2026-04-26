import { prisma } from "../src/lib/prisma";

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  
  // The 201 still showing
  const stuck = await prisma.service.findMany({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
    },
    select: {
      id: true,
      name: true,
      bulkmedyaId: true,
      lastPlacementError: true,
      ratePerK: true,
      minQuantity: true,
      maxQuantity: true,
      productCandidacies: { select: { lifecycleStatus: true } },
    },
  });
  console.log(`Total stuck services: ${stuck.length}`);

  // Check campaign #5 outcomes
  const c5 = await prisma.scoringCampaign.findUnique({ where: { id: 5 } });
  console.log(`\ncampaign#5: target=${c5?.targetServiceIds.length} placed=${c5?.placedCount} failed=${c5?.abortedCount} placedServiceIds=${c5?.placedServiceIds.length}`);

  // Were the 201 in campaign #5's targets? And in placedServiceIds?
  const c5Targets = new Set(c5?.targetServiceIds ?? []);
  const c5Placed = new Set(c5?.placedServiceIds ?? []);
  
  let inCampaign5 = 0, processedByCampaign5 = 0, skippedByCampaign5 = 0;
  for (const s of stuck) {
    if (c5Targets.has(s.id)) inCampaign5++;
    if (c5Placed.has(s.id)) processedByCampaign5++;
    else if (c5Targets.has(s.id)) skippedByCampaign5++;
  }
  console.log(`Of 201 stuck, ${inCampaign5} were targets in campaign#5`);
  console.log(`  → ${processedByCampaign5} marked as "placed" by campaign#5 (= attempted, success or fail)`);
  console.log(`  → ${skippedByCampaign5} skipped (= no_pool, never attempted)`);

  // Distribution of error messages — backfilled vs live
  const backfilled = stuck.filter((s) => s.lastPlacementError?.includes("backfilled")).length;
  const live = stuck.length - backfilled;
  console.log(`\nError stamp distribution:`);
  console.log(`  backfilled (= never re-attempted) : ${backfilled}`);
  console.log(`  live (= real BulkMedya rejection) : ${live}`);

  // Sample 10 LIVE errors to see what BulkMedya is actually saying
  const liveErrors = stuck.filter((s) => !s.lastPlacementError?.includes("backfilled"));
  console.log(`\n10 LIVE error samples (real BulkMedya rejections):`);
  for (const s of liveErrors.slice(0, 10)) {
    console.log(`  svc#${s.id} bulk=${s.bulkmedyaId} qty=${Math.max(20, s.minQuantity)} → "${s.lastPlacementError?.slice(0, 150)}"`);
  }

  // Lifecycle distribution
  const RANK: Record<string, number> = { NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4, PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8 };
  const buckets: Record<string, number> = {};
  for (const s of stuck) {
    let best = "NEW";
    for (const c of s.productCandidacies) {
      if (RANK[c.lifecycleStatus] > RANK[best]) best = c.lifecycleStatus;
    }
    buckets[best] = (buckets[best] ?? 0) + 1;
  }
  console.log(`\nLifecycle of stuck services:`);
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Pool availability check (TestAccount + TestPost available right now)
  const accountsAvail = await prisma.testAccount.count({
    where: { status: "available", active: true, accountType: "follower_test" },
  });
  const postsAvail = await prisma.testPost.count({ where: { status: "available" } });
  console.log(`\nPool availability NOW:`);
  console.log(`  follower_test accounts: ${accountsAvail}`);
  console.log(`  test posts: ${postsAvail}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
