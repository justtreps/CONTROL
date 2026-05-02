// Reliability score — 0..10 historical fault rate used as a
// tie-breaker after currentScore in the ranking engine.
//
// Definition over the last RELIABILITY_WINDOW finalised TestOrders
// (status ∈ {completed, completed_partial}):
//   perfect = delivered ≥ target           (100 % or over-delivery)
//   partial = 0 < delivered < target
//   fail    = delivered = 0
//
//   reliability = (perfect − partial − 2·fail) / WINDOW × 10
//   clamped to [0, 10].
//
// Tests that aborted (target_died / other / misplaced) don't count —
// those are pool/provider hygiene events, not delivery faults.
//
// When the service has fewer than RELIABILITY_MIN_SAMPLES finalised
// tests, the score is null: too thin a sample to be fair (a single
// partial would drop reliability to 8/10 with the absolute formula
// regardless of window). recomputeRanks treats null as the LOWEST
// tier-internal priority — services prove themselves before they
// can claim a tie-breaker bump.

import { prisma } from "@/lib/prisma";

export const RELIABILITY_WINDOW = 10;
export const RELIABILITY_MIN_SAMPLES = 5;

export type ReliabilityResult = {
  score: number | null;
  samples: number; // 0..RELIABILITY_WINDOW
  perfect: number;
  partial: number;
  fail: number;
};

/**
 * Compute reliability for a single service. Cheap — pulls at most
 * RELIABILITY_WINDOW rows + their measurements via include.
 *
 * Used in two places:
 *   1. onTestCompleted hook → updates Service.reliabilityScore in
 *      real time after each finalise.
 *   2. /api/scoring/recompute-reliability backfill → cold start
 *      after the column ships.
 */
export async function computeReliabilityForService(
  serviceId: number,
): Promise<ReliabilityResult> {
  const orders = await prisma.testOrder.findMany({
    where: {
      serviceId,
      status: { in: ["completed", "completed_partial"] },
    },
    select: {
      id: true,
      baselineCount: true,
      targetQuantity: true,
      measurements: { select: { actualCount: true } },
    },
    orderBy: { completedAt: "desc" },
    take: RELIABILITY_WINDOW,
  });

  let perfect = 0;
  let partial = 0;
  let fail = 0;

  for (const o of orders) {
    const peak = o.measurements.length
      ? Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount))
      : o.baselineCount;
    const delivered = Math.max(0, peak - o.baselineCount);
    const target = Math.max(1, o.targetQuantity);
    if (delivered >= target) {
      perfect++;
    } else if (delivered > 0) {
      partial++;
    } else {
      fail++;
    }
  }

  const samples = orders.length;
  if (samples < RELIABILITY_MIN_SAMPLES) {
    return { score: null, samples, perfect, partial, fail };
  }

  const raw = (perfect - partial - 2 * fail) / RELIABILITY_WINDOW;
  const score = Math.max(0, Math.min(10, raw * 10));
  return {
    score: Math.round(score * 10) / 10, // 1 decimal — e.g. 8.0, 7.5
    samples,
    perfect,
    partial,
    fail,
  };
}

/**
 * Persist the result on Service. Idempotent — safe to call from the
 * onTestCompleted hook on every finalise without coordinating across
 * polls.
 */
export async function refreshReliabilityForService(
  serviceId: number,
): Promise<ReliabilityResult> {
  const r = await computeReliabilityForService(serviceId);
  await prisma.service.update({
    where: { id: serviceId },
    data: {
      reliabilityScore: r.score,
      reliabilitySamples: r.samples,
    },
  });
  return r;
}

/**
 * Plain-language tier surfaced in the UI chip. Same buckets as the
 * spec from the operator: 9-10 très fiable / 7-8 fiable / 5-6 moyen
 * / <5 instable. null score → "—" / no chip.
 */
export type ReliabilityChip =
  | { label: "TRÈS FIABLE"; color: "green" }
  | { label: "FIABLE"; color: "blue" }
  | { label: "MOYEN"; color: "yellow" }
  | { label: "INSTABLE"; color: "red" };

export function reliabilityChip(score: number | null): ReliabilityChip | null {
  if (score === null) return null;
  if (score >= 9) return { label: "TRÈS FIABLE", color: "green" };
  if (score >= 7) return { label: "FIABLE", color: "blue" };
  if (score >= 5) return { label: "MOYEN", color: "yellow" };
  return { label: "INSTABLE", color: "red" };
}
