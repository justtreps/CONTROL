// Service-level scoring engine — last-test-only, transparent
// additive 4×25 = 100. No moving average, no Bayesian.
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
//   deltas. (Verified: lib/bulkmedya.ts exports only placeOrder,
//   fetchServices, syncServices — no getOrderStatus or similar.)
//
// SCORING — single formula, no smoothing:
//   score = LIVRAISON(0-25) + VITESSE(0-25) + DROP(0-25) + COÛT(0-25)
//   Service.currentScore = score of LATEST completed (or
//   completed_partial) TestOrder. Each new test overwrites.

import { prisma } from "@/lib/prisma";
import { consumeCompletedAssignments } from "@/lib/pool/assign";
import type { Measurement, TestOrder } from "@prisma/client";

type OrderWithMeasurements = TestOrder & { measurements: Measurement[] };

export type OrderScore = {
  orderId: number;
  // Sub-scores, each 0-25, additive to total 0-100.
  livraisonPts: number;
  vitessePts: number;
  dropPts: number;
  coutPts: number;
  // Raw metrics for UI / debug.
  completionPct: number;        // delivered / target, 0-1
  timeToFiftyMin: number | null; // null if 50% never reached
  dropPct: number;              // (peak - last) / peak, 0-1
  // Aggregate.
  final: number;                // 0-100
  hasDelivery: boolean;         // peak > baseline
};

const SUB_MAX = 25;

// Vitesse bracket — minutes from placement to first measurement
// where delivered ≥ 50% of target. No delivery → 0.
const VITESSE_BRACKETS: Array<[number, number]> = [
  [60, 25],     // < 1h
  [180, 22],    // 1-3h
  [360, 18],    // 3-6h
  [720, 15],    // 6-12h
  [1440, 12],   // 12-24h
  [2880, 6],    // 24-48h
  [Infinity, 2],// 48h+
];

function vitessePtsFor(timeToFiftyMin: number | null): number {
  if (timeToFiftyMin === null) return 0;
  for (const [threshold, pts] of VITESSE_BRACKETS) {
    if (timeToFiftyMin <= threshold) return pts;
  }
  return 2;
}

// Drop bracket. No delivery → 0 (not measurable).
function dropPtsFor(dropPct: number, hasDelivery: boolean): number {
  if (!hasDelivery) return 0;
  if (dropPct <= 0) return 25;
  if (dropPct < 0.10) return 22;
  if (dropPct < 0.20) return 18;
  if (dropPct < 0.30) return 12;
  if (dropPct < 0.50) return 6;
  return 0;
}

// Cost percentile → 0-25. Linear: cheapest = 25, most expensive
// = 0. costPercentile is 0..1 across the catalog (precomputed).
function coutPtsFor(costPercentile: number): number {
  return SUB_MAX * (1 - Math.min(1, Math.max(0, costPercentile)));
}

// Live cost percentile for a single service across the same cohort
// runScoringEngine uses (active services with ≥1 polled TestOrder).
// Exported so the /services/[id] detail page can show the SAME
// percentile the scoring engine used. Previously the detail page
// rolled its own filter (`status="completed"`) and its own bracket
// formula (15/10/5/0) — both diverged from the engine's linear
// percentile. Operators saw a Coût sub-score on the detail page
// that didn't add up to the displayed total.
export async function computeCostPercentileForService(
  serviceId: number
): Promise<number> {
  const me = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { ratePerK: true, minQuantity: true, maxQuantity: true },
  });
  if (!me) return 0.5;
  const myQty = Math.max(20, me.minQuantity);
  if (me.maxQuantity > 0 && myQty > me.maxQuantity) return 0.5;
  const myCost = (me.ratePerK * myQty) / 1000;

  const all = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: {
        some: { measurements: { some: { checkpoint: { not: "T+0" } } } },
      },
    },
    select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true },
  });
  const costs = all
    .map((s) => {
      const qty = Math.max(20, s.minQuantity);
      if (s.maxQuantity > 0 && qty > s.maxQuantity) return null;
      return { id: s.id, cost: (s.ratePerK * qty) / 1000 };
    })
    .filter((v): v is { id: number; cost: number } => v !== null)
    .sort((a, b) => a.cost - b.cost);
  if (costs.length <= 1) return 0.5;
  const idx = costs.findIndex((c) => c.id === serviceId);
  if (idx >= 0) return idx / (costs.length - 1);
  // Service not in the polled-cohort — splice myCost in by rank.
  const rank = costs.filter((c) => c.cost < myCost).length;
  return rank / (costs.length - 1);
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
  const completionPct = Math.min(
    1,
    delivered / Math.max(1, order.targetQuantity)
  );
  const hasDelivery = peakCount > order.baselineCount;

  // Vitesse: minutes to first measurement where delivered ≥ 50%
  // of target.
  const fiftyTargetCount =
    order.baselineCount + order.targetQuantity * 0.5;
  const fiftyHit = postBaseline.find((m) => m.actualCount >= fiftyTargetCount);
  const timeToFiftyMin = fiftyHit
    ? (fiftyHit.checkedAt.getTime() - order.placedAt.getTime()) / 60_000
    : null;

  // Drop: (peak - latest) / peak. Zero if no delivery.
  const lastMeas = postBaseline.length > 0
    ? postBaseline[postBaseline.length - 1]
    : null;
  let dropPct = 0;
  if (lastMeas && hasDelivery) {
    const netPeak = peakCount - order.baselineCount;
    const netAtLast = Math.max(0, lastMeas.actualCount - order.baselineCount);
    dropPct = Math.min(1, Math.max(0, (netPeak - netAtLast) / netPeak));
  }

  const livraisonPts = completionPct * SUB_MAX;
  const vitessePts = vitessePtsFor(timeToFiftyMin);
  const dropPts = dropPtsFor(dropPct, hasDelivery);
  const coutPts = coutPtsFor(costPercentile);
  const final = livraisonPts + vitessePts + dropPts + coutPts;

  return {
    orderId: order.id,
    livraisonPts,
    vitessePts,
    dropPts,
    coutPts,
    completionPct,
    timeToFiftyMin,
    dropPct,
    final,
    hasDelivery,
  };
}

export type ScoringResult = {
  servicesScored: number;
  servicesSkipped: number;
  rowsWritten: number;
  accountsConsumedByMeasurement: number;
  accountsConsumedByTimeout: number;
};

// Statuses that count as terminal "we have a final test result"
// — both completed (full delivery or T+7d sunset) and the new
// completed_partial (stagnation auto-finalize). Aborted variants
// stay excluded — they didn't produce a measurable signal.
export const SCORABLE_STATUSES = ["completed", "completed_partial"];

// Picks the test we'll score the service on. The rule used to be
// "latest by completedAt" which was a bug: a service with 3 fresh
// failing tests still showing 'running' kept its old completed
// success at the top of the rankings forever. Now the rule is:
//
//   Latest TestOrder by placedAt that has at least 1 non-T+0
//   Measurement. Status doesn't matter — running tests with at
//   least 1 poll count as scorable too. This way:
//
//   • Just-placed test (only T+0 baseline) → not yet scorable,
//     fall back to previous test
//   • Running test that's been polled → score on current state
//     (delivered / target / drop). If it's stagnating, the score
//     will be low and the operator sees it immediately.
//   • Completed test → score on final state.
//
// If the latest by placedAt has no polls yet, we pick the next-
// latest that does have polls.
//
// Exported (named on `pickLatestScorableTest`) so the service
// detail page can render the *same* test the scoring engine used
// instead of re-deriving its own (which previously diverged —
// detail showed "completed test from last week", score was based
// on a running test from yesterday).
export async function pickLatestScorableTest(serviceId: number) {
  // Pull the 5 most recent placements + their measurements.
  // 5 is enough: a service that has 5 just-placed tests with
  // zero polls is genuinely brand-new and deserves a null score.
  const recent = await prisma.testOrder.findMany({
    where: { serviceId },
    include: {
      measurements: {
        where: { checkpoint: { not: "T+0" } },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: { placedAt: "desc" },
    take: 5,
  });
  for (const o of recent) {
    if (o.measurements.length > 0) {
      // Refetch with all measurements (we only pulled 1 to test).
      const full = await prisma.testOrder.findUnique({
        where: { id: o.id },
        include: { measurements: true },
      });
      return full;
    }
  }
  return null;
}

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
  const consumed = await consumeCompletedAssignments();
  result.accountsConsumedByMeasurement = consumed.byMeasurement;
  result.accountsConsumedByTimeout = consumed.byTimeout;

  // Only loop services with ≥ 1 TestOrder that's been polled at
  // least once (a measurement beyond T+0). Status doesn't matter
  // for the loop filter — pickLatestScorableTest decides.
  const services = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: {
        some: { measurements: { some: { checkpoint: { not: "T+0" } } } },
      },
    },
    select: {
      id: true,
      ratePerK: true,
      minQuantity: true,
      maxQuantity: true,
    },
  });

  // Cost percentile thresholds for COÛT scoring. Sort all active
  // scorable services by per-test cost, map service.id → 0..1
  // percentile rank. Recomputed each scoring run so distribution
  // stays fresh as the catalog evolves.
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
    costRankByService.set(
      costs[i].id,
      costs.length > 1 ? i / (costs.length - 1) : 0.5
    );
  }

  for (const { id: serviceId } of services) {
    const latest = await pickLatestScorableTest(serviceId);

    if (!latest) {
      await resetStaleScore(serviceId);
      result.servicesSkipped++;
      continue;
    }

    // 'completed_partial' rows that delivered nothing still get
    // a score row — completion=0, vitesse=0, drop=0, coût=positive
    // gives an honest <30/100. The operator can act on that vs
    // the silent absence we had before.
    const costPercentile = costRankByService.get(serviceId) ?? 0.5;
    const score = computeOrderScore(latest, costPercentile);

    // Dedupe: skip the insert when the latest row matches this
    // score within 0.5 pts AND was written < 1h ago. Prevents
    // ServiceScore bloat (was ~1838 rows × 6/h × 24h = 264k/day).
    const previous = await prisma.serviceScore.findFirst({
      where: { serviceId },
      orderBy: { computedAt: "desc" },
      select: { currentScore: true, computedAt: true },
    });
    const oneHourAgo = Date.now() - 3600_000;
    const shouldSkip =
      previous &&
      Math.abs(previous.currentScore - score.final) < 0.5 &&
      previous.computedAt.getTime() > oneHourAgo;
    if (!shouldSkip) {
      await prisma.serviceScore.create({
        data: {
          serviceId,
          currentScore: score.final,
          completionFactor: score.completionPct,
          realismScore: 0,
          speedScore: score.vitessePts,
          dropScore: score.dropPts,
          rawScore: score.final,
          sampleCount: 1,
          confidence: 1,
          weightedScore: score.final,
          avgTimeToFiftyMin: score.timeToFiftyMin,
          avgDropPct: score.dropPct,
        },
      });
      result.rowsWritten++;
    }

    // Fan out to every candidacy row pointing at this service.
    // Always update PSC.currentScore — denormalisation must stay
    // fresh even when the ServiceScore insert is skipped.
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId },
      data: { currentScore: score.final, lastScoredAt: new Date() },
    });

    result.servicesScored++;
  }

  await recomputeRanks();
  return result;
}

// Compute + persist a single service's score from its latest
// scorable TestOrder. Called by the lifecycle hook on test
// completion so a score appears within seconds of finalize, not
// at the 10-min scoring cron tick.
export async function rescoreSingleService(serviceId: number): Promise<number | null> {
  const svc = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true, active: true },
  });
  if (!svc || !svc.active) return null;

  const latest = await pickLatestScorableTest(serviceId);
  if (!latest) return null;

  // Fast-path cost percentile — single DB scan over active
  // services with at least 1 polled TestOrder (matches the loop
  // filter in runScoringEngine).
  const allCosts = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: {
        some: { measurements: { some: { checkpoint: { not: "T+0" } } } },
      },
    },
    select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true },
  });
  const costs = allCosts
    .map((s) => {
      const qty = Math.max(20, s.minQuantity);
      if (s.maxQuantity > 0 && qty > s.maxQuantity) return null;
      return { id: s.id, cost: (s.ratePerK * qty) / 1000 };
    })
    .filter((v): v is { id: number; cost: number } => v !== null)
    .sort((a, b) => a.cost - b.cost);
  const idx = costs.findIndex((c) => c.id === serviceId);
  const costPercentile = idx < 0
    ? 0.5
    : costs.length > 1
      ? idx / (costs.length - 1)
      : 0.5;

  const score = computeOrderScore(latest, costPercentile);

  // Dedupe ServiceScore writes: poll-driven rescores can fire
  // every 12h on every TestOrder × 2700+ orders = thousands of
  // identical-score rows per day. Skip insert when previous
  // matches within 0.5 pts AND was written < 1h ago.
  const previous = await prisma.serviceScore.findFirst({
    where: { serviceId },
    orderBy: { computedAt: "desc" },
    select: { currentScore: true, computedAt: true },
  });
  const oneHourAgo = Date.now() - 3600_000;
  const shouldSkip =
    previous &&
    Math.abs(previous.currentScore - score.final) < 0.5 &&
    previous.computedAt.getTime() > oneHourAgo;
  if (!shouldSkip) {
    await prisma.serviceScore.create({
      data: {
        serviceId,
        currentScore: score.final,
        completionFactor: score.completionPct,
        realismScore: 0,
        speedScore: score.vitessePts,
        dropScore: score.dropPts,
        rawScore: score.final,
        sampleCount: 1,
        confidence: 1,
        weightedScore: score.final,
        avgTimeToFiftyMin: score.timeToFiftyMin,
        avgDropPct: score.dropPct,
      },
    });
  }
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId },
    data: { currentScore: score.final, lastScoredAt: new Date() },
  });
  return score.final;
}

// Called when no scorable TestOrder remains for a service.
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
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rank = r.currentScore == null ? null : i + 1;
      await prisma.productServiceCandidate.update({
        where: { id: r.id },
        data: { rank },
      });
    }
    await prisma.productServiceCandidate.updateMany({
      where: {
        productId: p.id,
        OR: [{ isEligible: false }, { forceExcluded: true }],
      },
      data: { rank: null },
    });
  }
}
