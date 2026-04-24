// Service-level scoring engine.
//
// RULE 1 (business): A service's currentScore stays null / gets
//   reset until AT LEAST ONE TestOrder on the service has a
//   Measurement proving RapidAPI observed real delivery
//   (actualCount > baselineCount). Anything BulkMedya claims about
//   "completed" is ignored — only what the oracle re-reads counts.
//
// RULE 2 (business): This file MUST NOT read BulkMedya status /
//   progress / remains. Scoring inputs are strictly: TestOrder
//   fields + Measurement (actualCount, realismScore) + time
//   deltas. If a future refactor adds a BulkMedya call here, it is
//   a regression — the comment above and the test below should
//   catch it. (Verified: lib/bulkmedya.ts exports only placeOrder,
//   fetchServices, syncServices — no getOrderStatus or similar.)
//
// If you need to surface BulkMedya state in the UI, do it in the
// /logs page reading the field as audit-only. Never feed it back
// into currentScore.
import { prisma } from "@/lib/prisma";
import { consumeCompletedAssignments } from "@/lib/pool/assign";
import type { Measurement, TestOrder } from "@prisma/client";

type OrderWithMeasurements = TestOrder & { measurements: Measurement[] };

export type OrderScore = {
  orderId: number;
  completion: number;
  realism: number;
  speed: number;
  drop: number;
  final: number;
  hasSevenDay: boolean;
  hasCompleted: boolean;
};

const SPEED_BUCKETS: Array<[number, number]> = [
  [5, 100],
  [30, 90],
  [120, 75],
  [24 * 60, 50],
  [72 * 60, 25],
];

function speedScore(deliveryMinutes: number | null): number {
  if (deliveryMinutes === null) return 0;
  for (const [threshold, score] of SPEED_BUCKETS) {
    if (deliveryMinutes <= threshold) return score;
  }
  return 0;
}

export function computeOrderScore(order: OrderWithMeasurements): OrderScore {
  const measurementsSorted = [...order.measurements].sort(
    (a, b) => a.checkedAt.getTime() - b.checkedAt.getTime()
  );

  const postBaseline = measurementsSorted.filter((m) => m.checkpoint !== "T+0");
  const all = measurementsSorted;

  const peakCount =
    all.length === 0
      ? order.baselineCount
      : Math.max(...all.map((m) => m.actualCount));

  const delivered = Math.max(0, peakCount - order.baselineCount);
  const completion = Math.min(1, delivered / Math.max(1, order.targetQuantity));

  const realism =
    postBaseline.length > 0
      ? postBaseline.reduce((acc, m) => acc + (m.realismScore ?? 0), 0) /
        postBaseline.length
      : 0;

  const targetReached = postBaseline.find(
    (m) => m.actualCount - order.baselineCount >= order.targetQuantity * 0.95
  );
  const deliveryMinutes = targetReached
    ? (targetReached.checkedAt.getTime() - order.placedAt.getTime()) / 60000
    : null;
  const speed = speedScore(deliveryMinutes);

  const sevenDay = postBaseline.find((m) => m.checkpoint === "T+7d");
  let drop = 100;
  if (sevenDay && peakCount > order.baselineCount) {
    const netPeak = peakCount - order.baselineCount;
    const netAtJ7 = Math.max(0, sevenDay.actualCount - order.baselineCount);
    const dropRatePct = ((netPeak - netAtJ7) / netPeak) * 100;
    drop = Math.max(0, 100 - dropRatePct * 5);
  }

  const final = completion * (realism * 0.4 + speed * 0.3 + drop * 0.3);

  return {
    orderId: order.id,
    completion,
    realism,
    speed,
    drop,
    final,
    hasSevenDay: Boolean(sevenDay),
    hasCompleted: deliveryMinutes !== null,
  };
}

export type ScoringResult = {
  servicesScored: number;
  servicesSkipped: number;
  rowsWritten: number;
  accountsConsumedByMeasurement: number;
  accountsConsumedByTimeout: number;
};

const MOVING_AVG_WINDOW = 30;

export async function runScoringEngine(): Promise<ScoringResult> {
  const result: ScoringResult = {
    servicesScored: 0,
    servicesSkipped: 0,
    rowsWritten: 0,
    accountsConsumedByMeasurement: 0,
    accountsConsumedByTimeout: 0,
  };

  // Pre-pass: flip assigned → consumed for any account whose test
  // has progressed past the T+0 baseline (or been stuck for 48h+).
  // Runs here instead of dedicated cron because scoring is the
  // natural "end-of-test" signal, and it fires every 10 min anyway.
  const consumed = await consumeCompletedAssignments();
  result.accountsConsumedByMeasurement = consumed.byMeasurement;
  result.accountsConsumedByTimeout = consumed.byTimeout;

  const services = await prisma.service.findMany({
    where: { active: true },
    select: { id: true },
  });

  for (const { id: serviceId } of services) {
    // Pull MOVING_AVG_WINDOW × 3 so the RULE 1 filter below has
    // enough raw orders to survive even on services where many
    // tests ran but nothing was actually delivered yet.
    const rawOrders = await prisma.testOrder.findMany({
      where: {
        serviceId,
        // Only count fully-completed tests in the moving average.
        // Aborted-target-died rows (auto-retry chain) are discarded
        // so a dead target can't drag a service's score down.
        status: "completed",
        measurements: { some: { checkpoint: { not: "T+0" } } },
      },
      include: { measurements: true },
      orderBy: { placedAt: "desc" },
      take: MOVING_AVG_WINDOW * 3,
    });

    // RULE 1 enforcement — keep only orders where at least one
    // RapidAPI measurement shows actualCount strictly above
    // baselineCount. No measured delivery → order is not eligible
    // for scoring. BulkMedya status is intentionally ignored.
    const orders = rawOrders
      .filter((o) => {
        const peak = Math.max(
          o.baselineCount,
          ...o.measurements.map((m) => m.actualCount)
        );
        return peak > o.baselineCount;
      })
      .slice(0, MOVING_AVG_WINDOW);

    if (orders.length === 0) {
      // If a prior scoring run stamped a currentScore on this
      // service but no order survives the RULE 1 filter anymore
      // (data drift, re-scrape, whatever), reset the stale score
      // so the /services + routing layer don't keep picking a
      // service based on a hallucinated signal.
      await resetStaleScore(serviceId);
      result.servicesSkipped++;
      continue;
    }

    const scores = orders.map(computeOrderScore);

    const avg = (pick: (s: OrderScore) => number) =>
      scores.reduce((acc, s) => acc + pick(s), 0) / scores.length;

    const finalScore = avg((s) => s.final);

    await prisma.serviceScore.create({
      data: {
        serviceId,
        currentScore: finalScore,
        completionFactor: avg((s) => s.completion),
        realismScore: avg((s) => s.realism),
        speedScore: avg((s) => s.speed),
        dropScore: avg((s) => s.drop),
      },
    });

    // Fan out to every ProductServiceCandidate row pointing at this
    // service — the same service can be a candidate for multiple
    // products (in practice not, since matchers are platform +
    // type specific, but the schema allows it). Only currentScore +
    // lastScoredAt are touched; rank is recomputed per-product
    // below.
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId },
      data: { currentScore: finalScore, lastScoredAt: new Date() },
    });

    result.servicesScored++;
    result.rowsWritten++;
  }

  // Re-rank every product's candidates. Top rank = 1 for the best
  // scored, ineligible / forceExcluded rows get rank=null (sit out
  // of the routing order entirely).
  await recomputeRanks();

  return result;
}

// Called when the RULE 1 filter leaves zero scorable orders for a
// service that previously had a currentScore. Nulls out the
// denormalised currentScore on every candidate row so routing
// stops treating the service as ranked. ServiceScore history is
// append-only (currentScore is non-nullable in that table), so
// we don't insert a placeholder — the absence of a fresh row is
// the signal that the service fell out of the scored set. No-op
// when there's nothing to reset.
async function resetStaleScore(serviceId: number): Promise<void> {
  const stale = await prisma.productServiceCandidate.count({
    where: { serviceId, currentScore: { not: null } },
  });
  if (stale === 0) return;
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId },
    data: { currentScore: null, lastScoredAt: new Date() },
  });
}

// Rewrites ProductServiceCandidate.rank for every active product.
// Called at the end of runScoringEngine and exposed so the catalogue
// page can offer a "rescorer" button.
export async function recomputeRanks(): Promise<void> {
  const products = await prisma.myBoostProduct.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  for (const p of products) {
    const rows = await prisma.productServiceCandidate.findMany({
      where: {
        productId: p.id,
        isEligible: true,
        forceExcluded: false,
      },
      orderBy: [
        { currentScore: { sort: "desc", nulls: "last" } },
        { id: "asc" },
      ],
      select: { id: true, currentScore: true },
    });
    // Assign rank 1..N to the in-order rows, null to the rest.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // null currentScore rows land at the tail — keep rank null so
      // the router only falls back to them once every scored one
      // has been tried.
      const rank = r.currentScore == null ? null : i + 1;
      await prisma.productServiceCandidate.update({
        where: { id: r.id },
        data: { rank },
      });
    }
    // Ineligible / forceExcluded rows — clear rank.
    await prisma.productServiceCandidate.updateMany({
      where: {
        productId: p.id,
        OR: [{ isEligible: false }, { forceExcluded: true }],
      },
      data: { rank: null },
    });
  }
}
