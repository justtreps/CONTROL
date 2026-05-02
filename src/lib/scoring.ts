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
//
// The poller fires its first tick at T+12h (see testbot.ts:placedAt
// + 12h). That's the soonest the engine can OBSERVE a delivery,
// regardless of how fast BulkMedya actually was — so any bracket
// shorter than 720 min is unreachable. The previous table had
// [60→25], [180→22], [360→18] entries which painted a misleading
// picture: operators thought 25-pt deliveries existed somewhere in
// the catalog when the math literally couldn't produce them.
//
// Brackets now reflect what the polling cadence can actually
// measure. If we ever add an early-cycle poll (T+1h spike), the
// table can be expanded back. Until then 12h-or-faster is the
// best-achievable tier.
const VITESSE_BRACKETS: Array<[number, number]> = [
  [720, 25],    // ≤12h — observed at first poll = "as fast as we can see"
  [1440, 18],   // 12-24h
  [2880, 12],   // 24-48h
  [4320, 6],    // 48-72h
  [Infinity, 2],// 72h+
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
//
// Services with broken pricing data (ratePerK <= 0 or minQuantity
// <= 0) are excluded. Without this filter, a service whose
// BulkMedya row had a 0-rate column would compute cost=0, land at
// percentile=0 (cheapest), and pocket the full 25 cost points —
// the scoring engine literally REWARDED broken catalog rows. We
// filter on construction now so the cohort represents real prices.
export async function computeCostPercentileForService(
  serviceId: number
): Promise<number> {
  const me = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { ratePerK: true, minQuantity: true, maxQuantity: true },
  });
  if (!me) return 0.5;
  if (me.ratePerK <= 0 || me.minQuantity <= 0) return 0.5;
  const myQty = Math.max(20, me.minQuantity);
  if (me.maxQuantity > 0 && myQty > me.maxQuantity) return 0.5;
  const myCost = (me.ratePerK * myQty) / 1000;

  const all = await prisma.service.findMany({
    where: {
      active: true,
      ratePerK: { gt: 0 },
      minQuantity: { gt: 0 },
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
  // Pricing-broken rows (ratePerK<=0 or minQuantity<=0) are excluded
  // from the cost cohort: leaving them in would flush the percentile
  // 0 (cheapest) and they'd score the full 25 cost points despite
  // being unsellable.
  const services = await prisma.service.findMany({
    where: {
      active: true,
      ratePerK: { gt: 0 },
      minQuantity: { gt: 0 },
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
  // filter in runScoringEngine, including the rate>0 guard).
  const allCosts = await prisma.service.findMany({
    where: {
      active: true,
      ratePerK: { gt: 0 },
      minQuantity: { gt: 0 },
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

// Tier-based ranking. The previous score-only sort was unfair to
// services with confirmed-but-modest delivery: a fresh test that
// hasn't been polled yet (currentScore stale from a partial test)
// could outrank a service that just delivered 90 % on its latest
// run, because the routing didn't know which one had the freshest
// signal. Operators surfaced the symptom: "service that delivered
// 45/50 ranks 138 while a never-tested service ranks at the top".
//
// Tiers, computed from the SERVICE's most-recent TestOrder
// (regardless of status, regardless of polled state):
//
//   TIER_DELIVERED_HIGH = 1  → latest test polled with delivered ≥
//                              50 % of target. Top-of-list.
//   TIER_DELIVERED_LOW  = 2  → latest test polled with delivered
//                              1-49 % of target.
//   TIER_PENDING        = 3  → latest test placed but no non-T+0
//                              measurement yet (in-flight, deserves
//                              the benefit of the doubt over a
//                              service that confirmed 0 delivery).
//   TIER_NO_DELIVERY    = 4  → latest test FINALISED with delivered
//                              == 0. Bottom of list.
//
// Within a tier, sort by currentScore DESC.

type ServiceTierRow = {
  serviceId: number;
  tier: number;
};

// One batched SQL pass: for every service, compute tier from the
// LATEST SCORABLE TestOrder (most recent placedAt with ≥1 non-T+0
// measurement). This matches pickLatestScorableTest's definition
// of "scorable" — a fresh in-flight test that hasn't been polled
// yet doesn't push a tier-1 service into tier 3, because we keep
// the prior scorable test as the reference until the new one
// gets its first poll.
//
// Services with NO scorable test fall back to a per-service
// "latest TestOrder" check so we can still distinguish:
//   • placed-but-never-polled (TIER_PENDING)
//   • finalised with 0 delivery (TIER_NO_DELIVERY)
//   • truly never tested (no row at all → tier 3 default)
async function computeAllTiers(): Promise<Map<number, number>> {
  type ScorableRow = {
    serviceId: number;
    targetQuantity: number;
    baselineCount: number;
    peak: number | bigint;
  };
  type LatestRow = {
    serviceId: number;
    status: string;
    has_scorable: boolean;
  };

  // Pull latest scorable per service.
  const scorable = await prisma.$queryRaw<ScorableRow[]>`
    WITH scorable_orders AS (
      SELECT DISTINCT ON (tor."serviceId")
        tor."serviceId", tor.id, tor."targetQuantity", tor."baselineCount"
      FROM "TestOrder" tor
      WHERE EXISTS (
        SELECT 1 FROM "Measurement" m
        WHERE m."testOrderId" = tor.id
          AND m.checkpoint != 'T+0'
      )
      ORDER BY tor."serviceId", tor."placedAt" DESC
    )
    SELECT
      s."serviceId" as "serviceId",
      s."targetQuantity" as "targetQuantity",
      s."baselineCount" as "baselineCount",
      COALESCE(
        (SELECT MAX(m."actualCount")
           FROM "Measurement" m
           WHERE m."testOrderId" = s.id
             AND m.checkpoint != 'T+0'),
        s."baselineCount"
      ) as peak
    FROM scorable_orders s
  `;

  // Latest TestOrder per service (any status) — tells us whether
  // a service is in-flight (TIER 3) or finalised with 0 delivery
  // (TIER 4) when no scorable test exists.
  const latest = await prisma.$queryRaw<LatestRow[]>`
    SELECT DISTINCT ON (tor."serviceId")
      tor."serviceId" as "serviceId",
      tor.status as status,
      EXISTS (
        SELECT 1 FROM "Measurement" m
        WHERE m."testOrderId" = tor.id
          AND m.checkpoint != 'T+0'
      ) as has_scorable
    FROM "TestOrder" tor
    ORDER BY tor."serviceId", tor."placedAt" DESC
  `;

  const TERMINAL = new Set([
    "completed",
    "completed_partial",
    "aborted_target_died",
    "aborted_other",
  ]);
  const out = new Map<number, number>();

  // First pass — services with at least one scorable test.
  for (const s of scorable) {
    const peak = Number(s.peak);
    const delivered = Math.max(0, peak - s.baselineCount);
    const pct =
      s.targetQuantity > 0
        ? Math.min(1, delivered / s.targetQuantity)
        : 0;
    let tier: number;
    if (pct >= 0.5) tier = 1;
    else if (pct > 0) tier = 2;
    // pct === 0 on a scorable test = polled but delivered 0. If
    // the latest is FINALISED, it's a confirmed zero (TIER 4).
    // Otherwise still in-flight (TIER 3).
    else {
      const lat = latest.find((l) => l.serviceId === s.serviceId);
      tier = lat && TERMINAL.has(lat.status) ? 4 : 3;
    }
    out.set(s.serviceId, tier);
  }

  // Second pass — services with NO scorable test (latest never
  // polled). Use the latest row's status to decide.
  for (const l of latest) {
    if (out.has(l.serviceId)) continue;
    out.set(l.serviceId, TERMINAL.has(l.status) ? 4 : 3);
  }
  return out;
}

// Rewrites ProductServiceCandidate.rank for every active product.
//
// Sort key (lex): tier ASC, currentScore DESC, reliabilityScore DESC.
// Reliability acts as the tie-breaker on services that share a
// currentScore: a 93/93 pair where one has 10/10 reliability and
// the other has 7/10 ranks the 10/10 first. null reliability sorts
// LAST inside its tier+score group — services prove themselves with
// at least RELIABILITY_MIN_SAMPLES finalised tests before they can
// claim the bump.
export async function recomputeRanks(): Promise<void> {
  const tiers = await computeAllTiers();
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
      select: {
        id: true,
        serviceId: true,
        currentScore: true,
        // Pull reliability via the service join so we don't need a
        // second SELECT round-trip per candidate. Cheap — the
        // existing query already touches Service rows for the
        // dashboard.
        service: { select: { reliabilityScore: true } },
      },
    });
    const tiered = rows.map((r) => ({
      id: r.id,
      tier: tiers.get(r.serviceId) ?? 3,
      score: r.currentScore ?? -1,
      // -1 sentinel for "no reliability yet" so it lands below any
      // computed score (legitimate range is 0..10).
      reliability: r.service.reliabilityScore ?? -1,
    }));
    tiered.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.score !== a.score) return b.score - a.score;
      return b.reliability - a.reliability;
    });
    // Batch the rank writes — one transaction per product avoids
    // 8 000 separate round-trips per cron tick.
    await prisma.$transaction(
      tiered.map((r, i) =>
        prisma.productServiceCandidate.update({
          where: { id: r.id },
          data: { rank: i + 1 },
        }),
      ),
    );
    await prisma.productServiceCandidate.updateMany({
      where: {
        productId: p.id,
        OR: [{ isEligible: false }, { forceExcluded: true }],
      },
      data: { rank: null },
    });
  }
}

// Exported for diag / unit tests — same logic computeAllTiers uses.
export { computeAllTiers };
export type { ServiceTierRow };
