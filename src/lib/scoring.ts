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
  // Sub-scores (0-40, 0-50, 0-10) — additive to total raw 0-100.
  completionPts: number;
  speedPts: number;
  dropPts: number;
  // Raw metrics surfaced for the dashboard + drawer.
  completionPct: number;        // delivered / target, 0-1
  timeToFiftyMin: number | null; // null if 50% never reached
  dropPct: number;              // (peak - final) / peak, 0-1; 0 if no peak
  // Aggregate.
  final: number;                // 0-100
  hasSevenDay: boolean;
  hasDelivery: boolean;         // peak > baseline
};

// Speed bracket — minutes from placement until 50% of target
// delivered. Faster = higher pts (max 50). Bracketed instead of
// continuous so a 1h:01m service doesn't get a perceptible
// penalty vs 0h:59m, but a 6h vs 12h gap is sharp.
const SPEED_BRACKETS: Array<[number, number]> = [
  [60, 50],         // < 1h
  [180, 40],        // 1-3h
  [360, 30],        // 3-6h
  [720, 20],        // 6-12h
  [1440, 10],       // 12-24h
  [2880, 5],        // 24-48h
];

function speedPtsFor(timeToFiftyMin: number | null): number {
  if (timeToFiftyMin === null) return 0;
  for (const [threshold, pts] of SPEED_BRACKETS) {
    if (timeToFiftyMin <= threshold) return pts;
  }
  return 0;
}

// Drop bracket — what % of delivery survived between peak and
// final (T+7d) measurement. Drop > 30 % = punishment.
function dropPtsFor(dropPct: number): number {
  if (dropPct <= 0) return 10;
  if (dropPct < 0.10) return 7;
  if (dropPct < 0.30) return 4;
  return 0;
}

export function computeOrderScore(order: OrderWithMeasurements): OrderScore {
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

  const completionPts = completionPct * 40;
  const speedPts = speedPtsFor(timeToFiftyMin);
  const dropPts = dropPtsFor(dropPct);
  const final = completionPts + speedPts + dropPts; // 0-100

  return {
    orderId: order.id,
    completionPts,
    speedPts,
    dropPts,
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

    // Sub-scores feeding rawScore (additive, 0-100).
    const completionPtsAvg = avg((s) => s.completionPts);
    const speedPtsAvg = avg((s) => s.speedPts);
    const dropPtsAvg = avg((s) => s.dropPts);
    const rawScore = completionPtsAvg + speedPtsAvg + dropPtsAvg;

    // Bayesian smoothing — pulls low-sample scores toward a
    // prior of 50 with weight 5. A service with 0 samples
    // wouldn't be in this loop at all (RULE 1 filter), but a
    // 1-sample service ends up at (raw + 250)/6 — far less
    // dominant than its raw value alone.
    const sampleCount = orders.length;
    const PRIOR = 50;
    const PRIOR_WEIGHT = 5;
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
