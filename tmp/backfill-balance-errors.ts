// One-shot retroactive backfill for the BalanceRetryCard.
//
// The Service.lastPlacementError column landed AFTER the day's
// failures, so the live capture path missed them. This stamps a
// synthetic "balance_insufficient_estimated" error on every
// service that:
//   • has a candidacy with lifecycleStatus = PLACEMENT_FAILED, OR
//   • has a TestOrder.status starting with "aborted" or
//     abortReason containing balance markers, in the last 24h
//
// The synthetic marker satisfies the regex used by
// getBalanceRetryBudget() so the card lights up. The probe in
// /api/balance/retry-failed will sort out which were truly
// balance-bounced vs other rejections.

import { prisma } from "../src/lib/prisma";
import { getBalanceRetryBudget } from "../src/lib/balance/retry-budget";

const SYNTHETIC = "balance_insufficient_estimated (backfilled)";
const BALANCE_MARKERS = /balance|insufficient|neutral|fund|not enough|low ?bal/i;

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60_000);

  // 1. Services with PLACEMENT_FAILED candidacies (any age — the
  //    user wants the full backlog of failed placements covered).
  const placementFailedSvcs = await prisma.productServiceCandidate.findMany({
    where: { lifecycleStatus: "PLACEMENT_FAILED" },
    select: { serviceId: true },
    distinct: ["serviceId"],
  });
  console.log(
    `Distinct services with lifecycleStatus=PLACEMENT_FAILED: ${placementFailedSvcs.length}`
  );

  // 2. Services with TestOrder aborted/aborted_* in the last 24h.
  const abortedTOs = await prisma.testOrder.findMany({
    where: {
      placedAt: { gte: since },
      OR: [
        { status: { startsWith: "aborted" } },
        { abortReason: { contains: "balance" } },
        { abortReason: { contains: "insufficient" } },
      ],
    },
    select: { serviceId: true, abortReason: true },
  });
  const abortedSvcIds = Array.from(new Set(abortedTOs.map((o) => o.serviceId)));
  console.log(`Distinct services with aborted TestOrder in 24h: ${abortedSvcIds.length}`);

  // Sample 5 actual abortReasons so we can sanity-check the
  // signal before stamping (some aborts are pool/private
  // failures, not balance — we still flag them since the probe
  // will sort it out later).
  const sampleReasons = abortedTOs
    .filter((o) => o.abortReason)
    .slice(0, 5)
    .map((o) => o.abortReason);
  console.log(`Sample abortReason strings:`);
  for (const r of sampleReasons) console.log(`  · ${r}`);

  // Union of both sets.
  const all = new Set<number>();
  for (const r of placementFailedSvcs) all.add(r.serviceId);
  for (const id of abortedSvcIds) all.add(id);
  console.log(`\nUnion (services to stamp): ${all.size}`);

  // Don't stamp services that ALREADY have a recent error — they
  // were captured by the live path post-deploy and we'd overwrite
  // a real message with the synthetic marker.
  const existing = await prisma.service.findMany({
    where: {
      id: { in: Array.from(all) },
      lastPlacementErrorAt: { gte: since },
    },
    select: { id: true, lastPlacementError: true },
  });
  const skipIds = new Set(
    existing
      .filter((s) => s.lastPlacementError && BALANCE_MARKERS.test(s.lastPlacementError))
      .map((s) => s.id)
  );
  console.log(`Skip (already have recent live error): ${skipIds.size}`);

  const stampIds = Array.from(all).filter((id) => !skipIds.has(id));
  console.log(`Will stamp: ${stampIds.length}`);

  if (stampIds.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const r = await prisma.service.updateMany({
    where: { id: { in: stampIds } },
    data: {
      lastPlacementError: SYNTHETIC,
      lastPlacementErrorAt: new Date(),
    },
  });
  console.log(`\nStamped ${r.count} services with synthetic balance marker.`);

  // Re-run the budget computation — this is what the dashboard
  // card will read on its next refresh.
  console.log("\n=== getBalanceRetryBudget() AFTER backfill ===");
  const budget = await getBalanceRetryBudget();
  console.log(`  failedCount  : ${budget.failedCount}`);
  console.log(`  minBudgetUsd : $${budget.minBudgetUsd.toFixed(2)}`);
  console.log(`  sample top 5 by cost:`);
  for (const s of budget.sample) {
    console.log(`    svc#${s.id} ${s.platform} $${s.cost.toFixed(2)} — ${s.name.slice(0, 60)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
