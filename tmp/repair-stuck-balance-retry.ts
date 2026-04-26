// Repair script for the balance retry that placed successfully
// but left services stuck in PLACEMENT_FAILED.
//
// Cause: placeBruteOne previously updated lifecycleStatus only
// when current status was NEW. Backfilled services were in
// PLACEMENT_FAILED, so successful retries created TestOrders
// without flipping the candidacy state. The backfilled stamp
// also stayed because lastPlacementError clear wasn't shipped
// at the time of the run.
//
// Identify services that have a TestOrder created AFTER the
// retry button was clicked (campaign #5 startedAt ~05:49 UTC)
// — they placed successfully. For each:
//   • Flip candidacies PLACEMENT_FAILED → TESTING + isEligible
//   • Clear lastPlacementError + lastPlacementErrorAt
//
// The remaining services (no recent TestOrder) genuinely failed
// the retry — keep their PLACEMENT_FAILED state, but rewrite the
// stamp to a non-backfilled marker so we can tell them apart in
// future audits.

import { prisma } from "../src/lib/prisma";

async function main() {
  const retryStart = new Date("2026-04-26T05:49:00.000Z");

  // Services with a TestOrder placed after retry kickoff = the
  // 693 success cases.
  const recentOrders = await prisma.testOrder.findMany({
    where: { placedAt: { gte: retryStart } },
    select: { serviceId: true },
    distinct: ["serviceId"],
  });
  const placedIds = recentOrders.map((o) => o.serviceId);
  console.log(`TestOrders placed after retry kickoff: distinct services = ${placedIds.length}`);

  // Of those, intersect with services currently stuck in
  // PLACEMENT_FAILED with a backfilled stamp.
  const stuckSuccessful = await prisma.service.findMany({
    where: {
      id: { in: placedIds },
      lastPlacementError: { contains: "backfilled" },
    },
    select: { id: true },
  });
  console.log(`Of those, stuck in PLACEMENT_FAILED with backfilled stamp: ${stuckSuccessful.length}`);

  if (stuckSuccessful.length > 0) {
    const ids = stuckSuccessful.map((s) => s.id);
    // Clear the stamp — placement actually succeeded, BulkMedya
    // accepted, balance was OK at retry time.
    const cleared = await prisma.service.updateMany({
      where: { id: { in: ids } },
      data: {
        lastPlacementError: null,
        lastPlacementErrorAt: null,
      },
    });
    // Flip candidacies PLACEMENT_FAILED → TESTING + restore
    // isEligible (since we know placement worked).
    const flipped = await prisma.productServiceCandidate.updateMany({
      where: {
        serviceId: { in: ids },
        lifecycleStatus: "PLACEMENT_FAILED",
      },
      data: { lifecycleStatus: "TESTING", isEligible: true },
    });
    console.log(`✓ Cleared lastPlacementError on ${cleared.count} services`);
    console.log(`✓ Flipped ${flipped.count} candidacies PLACEMENT_FAILED → TESTING`);
  }

  // Recompute budget post-repair.
  const { getBalanceRetryBudget } = await import("../src/lib/balance/retry-budget");
  const budget = await getBalanceRetryBudget();
  console.log(`\n=== getBalanceRetryBudget() AFTER repair ===`);
  console.log(`  failedCount  : ${budget.failedCount}`);
  console.log(`  minBudgetUsd : $${budget.minBudgetUsd.toFixed(2)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
