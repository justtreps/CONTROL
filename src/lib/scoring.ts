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
  // Sub-scores. 0-30 / 0-50 / 0-5 / 0-15 = total 100.
  completionPts: number;
  speedPts: number;
  dropPts: number;
  costPts: number;
  // Raw metrics surfaced for the dashboard + drawer.
  completionPct: number;        // delivered / target, 0-1
  timeToFiftyMin: number | null; // null if 50% never reached
  dropPct: number;              // (peak - final) / peak, 0-1; 0 if no peak
  // Aggregate.
  final: number;                // 0-100
  hasSevenDay: boolean;
  hasDelivery: boolean;         // peak > baseline
};

// Score component weights — sum to 100.
//
// Calibration history: completion was 40 pts and drop was 10
// pts but observation showed completion saturated at 1.0 and
// drop saturated at 0 % across virtually every QUALIFIED
// service. Both dimensions degenerated to a fixed +50 offset
// that compressed the total into a 50-60 band. Reduced their
// weights and added COST_EFFICIENCY which actually varies per
// service to widen the score distribution.
//
// Speed remains 50 pts — it's the only dimension that produces
// real variance across the catalog (and the variance ceiling is
// limited by the 12h polling cadence — a service that delivers
// in 30 min still measures as "delivered ≤ 12h").
const COMPLETION_PTS_MAX = 30;
const SPEED_PTS_MAX = 50;
const DROP_PTS_MAX = 5;
const COST_PTS_MAX = 15;

const SPEED_BRACKETS: Array<[number, number]> = [
  [60, SPEED_PTS_MAX],         // < 1h
  [180, 40],                    // 1-3h
  [360, 30],                    // 3-6h
  [720, 20],                    // 6-12h
  [1440, 10],                   // 12-24h
  [2880, 5],                    // 24-48h
];

function speedPtsFor(timeToFiftyMin: number | null): number {
  if (timeToFiftyMin === null) return 0;
  for (const [threshold, pts] of SPEED_BRACKETS) {
    if (timeToFiftyMin <= threshold) return pts;
  }
  return 0;
}

// Drop bracket scaled to the new 0-5 max.
function dropPtsFor(dropPct: number): number {
  if (dropPct <= 0) return DROP_PTS_MAX;
  if (dropPct < 0.10) return Math.round(DROP_PTS_MAX * 0.7);
  if (dropPct < 0.30) return Math.round(DROP_PTS_MAX * 0.4);
  return 0;
}

// Cost percentile → points. Ranked across all currently-active
// scorable services so we always have a fresh distribution.
function costPtsFor(costPercentile: number): number {
  // Lower percentile = cheaper = better.
  if (costPercentile <= 0.25) return COST_PTS_MAX;            // top 25 % cheapest
  if (costPercentile <= 0.50) return Math.round(COST_PTS_MAX * 0.66);
  if (costPercentile <= 0.75) return Math.round(COST_PTS_MAX * 0.33);
  return 0;
}

export function computeOrderScore(
  order: OrderWithMeasurements,
  costPercentile = 0.5,
): OrderScore {
  const measurementsSorted = [...order.measurements].sort(
    (a, b) => a.checkedAt.getTime() - b.checkedAt.getTime()
  );
  const postBaseline = measurementsSorted.filter((m) => m.checkpoint !== "T+0");

  const peakCount =
    measurementsSorted.length === 0
      ? order.baselineCount
      : Math.max(...measurementsSorted.map((m) => m.actualCount));
  const delivered = Math.max(0, peakCount - order.baselineCount);
  const completionPct = Math.min(1, delivered / Math.max(1, order.targetQuantity));

  // ── Speed: minutes from placement to first measurement where
  //    delivered ≥ 50 % of target. Linear-scan postBaseline rows
  //    sorted ascending by checkedAt (already sorted above).
  const fiftyTargetCount =
    order.baselineCount + order.targetQuantity * 0.5;
  const fiftyHit = postBaseline.find((m) => m.actualCount >= fiftyTargetCount);
  const timeToFiftyMin = fiftyHit
    ? (fiftyHit.checkedAt.getTime() - order.placedAt.getTime()) / 60_000
    : null;

  // ── Drop: between peakCount and the most recent post-baseline
  //    measurement. We don't gate on T+7d existing — the
  //    interim drop signal still informs the score on services
  //    that haven't reached the sunset yet.
  const lastMeas = postBaseline.length > 0
    ? postBaseline[postBaseline.length - 1]
    : null;
  const sevenDay = postBaseline.find((m) => m.checkpoint === "T+7d");
  let dropPct = 0;
  if (lastMeas && peakCount > order.baselineCount) {
    const netPeak = peakCount - order.baselineCount;
    const netAtLast = Math.max(0, lastMeas.actualCount - order.baselineCount);
    dropPct = Math.min(1, Math.max(0, (netPeak - netAtLast) / netPeak));
  }

  const completionPts = completionPct * COMPLETION_PTS_MAX;
  const speedPts = speedPtsFor(timeToFiftyMin);
  const dropPts = dropPtsFor(dropPct);
  const costPts = costPtsFor(costPercentile);
  const final = completionPts + speedPts + dropPts + costPts; // 0-100

  return {
    orderId: order.id,
    completionPts,
    speedPts,
    dropPts,
    costPts,
    completionPct,
    timeToFiftyMin,
    dropPct,
    final,
    hasSevenDay: Boolean(sevenDay),
    hasDelivery: peakCount > order.baselineCount,
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

  // Only loop services with ≥ 1 completed TestOrder. Saves
  // ~4 000 wasted iterations on out-of-scope services that have
  // never been tested.
  const services = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: { some: { status: "completed" } },
    },
    select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true },
  });

  // Cost percentile thresholds for COST_EFFICIENCY scoring. Sort
  // ALL active scorable services by per-test cost, then use
  // quartile thresholds to map each service's cost to a percentile
  // rank in computeOrderScore. Computed once per scoring run so
  // we don't re-sort per service.
  const costs = services
    .map((s) => {
      const qty = Math.max(20, s.minQuantity);
      if (s.maxQuantity > 0 && qty > s.maxQuantity) return null;
      return { id: s.id, cost: (s.ratePerK * qty) / 1000 };
    })
    .filter((v): v is { id: number; cost: number } => v !== null)
    .sort((a, b) => a.cost - b.cost);
  const costRankByService = new Map<number, number>();
  for (let i = 0; i < costs.length; i++) {
    costRankByService.set(costs[i].id, costs.length > 1 ? i / (costs.length - 1) : 0.5);
  }

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

    const costPercentile = costRankByService.get(serviceId) ?? 0.5;
    const scores = orders.map((o) => computeOrderScore(o, costPercentile));

    const avg = (pick: (s: OrderScore) => number) =>
      scores.reduce((acc, s) => acc + pick(s), 0) / scores.length;

    // Sub-scores feeding rawScore (additive, 0-100).
    const completionPtsAvg = avg((s) => s.completionPts);
    const speedPtsAvg = avg((s) => s.speedPts);
    const dropPtsAvg = avg((s) => s.dropPts);
    const costPtsAvg = avg((s) => s.costPts);
    const rawScore =
      completionPtsAvg + speedPtsAvg + dropPtsAvg + costPtsAvg;

    // Bayesian smoothing. Lowered prior weight 5 → 2 so the
    // raw signal dominates: 1131 services were stuck in a
    // 50-58 band because (raw+250)/6 squashed everything.
    // (raw*n + 50*2)/(n+2) gives more swing while still
    // protecting against a single lucky test.
    const sampleCount = orders.length;
    const PRIOR = 50;
    const PRIOR_WEIGHT = 2;
    const weightedScore =
      (rawScore * sampleCount + PRIOR * PRIOR_WEIGHT) /
      (sampleCount + PRIOR_WEIGHT);

    // Confidence kept as a UI hint (not used in math anymore).
    const confidence = Math.min(1, sampleCount / 10);

    // Aggregate metrics for the dashboard top/flop tables.
    const timesToFifty = scores
      .map((s) => s.timeToFiftyMin)
      .filter((v): v is number => v !== null);
    const avgTimeToFiftyMin =
      timesToFifty.length > 0
        ? timesToFifty.reduce((a, b) => a + b, 0) / timesToFifty.length
        : null;
    const avgDropPct = avg((s) => s.dropPct);

    await prisma.serviceScore.create({
      data: {
        serviceId,
        // currentScore = weightedScore so any legacy reader
        // (RoutingDecision audit, /services list, etc.) gets the
        // smoothed view automatically.
        currentScore: weightedScore,
        // Legacy sub-score columns kept for backwards compat —
        // we now store them as "X / 100" normalized so the old
        // schema readers don't see scale shifts.
        completionFactor: avg((s) => s.completionPct),
        realismScore: 0, // realism dropped from the formula
        speedScore: speedPtsAvg * 2, // 0-100 scale
        dropScore: dropPtsAvg * 10, // 0-100 scale
        rawScore,
        sampleCount,
        confidence,
        weightedScore,
        avgTimeToFiftyMin,
        avgDropPct,
      },
    });

    // Fan out the weighted score to every candidacy row pointing
    // at this service. Routing + dashboard tables read
    // candidate.currentScore for ranking; weighted is what we
    // want them to see.
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId },
      data: { currentScore: weightedScore, lastScoredAt: new Date() },
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
