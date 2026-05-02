// Reliability — historical fault rate applied as a multiplicative
// factor on the raw score. Replaces the previous standalone "0..10
// score" model which the operator surfaced as confusing (two
// separate numbers to compare).
//
// Definition over ALL finalised TestOrders for a service
// (status ∈ {completed, completed_partial}; aborted_* excluded —
// those are pool/provider hygiene events, not delivery faults):
//
//   perfect_count = #{ delivered ≥ target }
//   partial_count = #{ 0 < delivered < target }
//   fail_count    = #{ delivered = 0 }
//   total_finalized = perfect + partial + fail
//
//   reliability_factor =
//     • 1.0   when total_finalized < RELIABILITY_MIN_SAMPLES (5)
//             (not enough history to penalise fairly)
//     • 0.5 + 0.5 × (perfect / total_finalized)   otherwise
//             (range [0.5, 1.0])
//
//   currentScore = scoreRaw × reliability_factor
//
// Effects:
//   - 100 % perfect: factor 1.00 → score unchanged
//   - 50 % perfect : factor 0.75 → score reduced by a quarter
//   - 0 % perfect  : factor 0.50 → score halved
//   - <5 finalised : factor 1.00 → no penalty (cohort proves itself first)
//
// Note: the previous fixed-window helper (last 10 tests) is gone.
// We now look at the FULL finalised history because the multiplier
// model wants long-run fault signal — a service that has 50 tests
// with 5 failures has clearly different reliability than one with
// 10 tests and the same 5 failures. Aborted_* rows still excluded.

import { prisma } from "@/lib/prisma";

// Below this many finalised tests, no penalty applies. Mirrors the
// previous helper's threshold so the operator's mental model stays
// the same ("services prove themselves before being penalised").
export const RELIABILITY_MIN_SAMPLES = 5;

// Backward-compat export — RELIABILITY_WINDOW used to mean "look
// back this many tests". The new model uses the full history; the
// constant is kept so any leftover import doesn't break the build.
// Equivalent semantics: the window is unbounded.
export const RELIABILITY_WINDOW = 10;

export type ReliabilityResult = {
  perfect: number;
  partial: number;
  fail: number;
  /** Total finalised TestOrders considered (perfect + partial + fail). */
  totalFinalized: number;
  /** [0.5, 1.0] when totalFinalized ≥ MIN_SAMPLES, else null (treat as 1.0). */
  factor: number | null;
  /**
   * 1.0 fallback — what to actually multiply by. null factor → 1.0.
   * Use this in scoring math so the call site doesn't have to special-
   * case null.
   */
  factorOrOne: number;
  /**
   * Legacy 0..10 surface. Computed from factor for backward-compat
   * with code paths that still read reliabilityScore. Roughly:
   *   score = (factor - 0.5) × 20  ⇒  factor 1.0 = 10, factor 0.5 = 0.
   * null when factor is null.
   */
  legacyScore: number | null;
};

export type ReliabilityChip =
  | { label: "TRÈS FIABLE"; color: "green" }
  | { label: "FIABLE"; color: "blue" }
  | { label: "MOYEN"; color: "yellow" }
  | { label: "INSTABLE"; color: "red" };

/**
 * Compute reliability for a single service from its finalised
 * TestOrders. Cheap — one indexed query + N measurement reads.
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
    if (delivered >= target) perfect++;
    else if (delivered > 0) partial++;
    else fail++;
  }

  const totalFinalized = perfect + partial + fail;
  let factor: number | null = null;
  if (totalFinalized >= RELIABILITY_MIN_SAMPLES) {
    const ratio = perfect / totalFinalized;
    factor = 0.5 + 0.5 * ratio;
    // 2-decimal rounding so the display + persistence agree
    factor = Math.round(factor * 100) / 100;
  }
  const factorOrOne = factor ?? 1.0;
  const legacyScore =
    factor === null
      ? null
      : Math.round(((factor - 0.5) * 20) * 10) / 10; // factor 1.0 → 10.0, factor 0.5 → 0.0

  return {
    perfect,
    partial,
    fail,
    totalFinalized,
    factor,
    factorOrOne,
    legacyScore,
  };
}

/**
 * Persist the reliability result on Service. Updates BOTH the new
 * shape (perfectCount/partialCount/failCount/reliabilityFactor) AND
 * the legacy shape (reliabilityScore/reliabilitySamples) so any
 * code reading either gets consistent values during the migration.
 */
export async function refreshReliabilityForService(
  serviceId: number,
): Promise<ReliabilityResult> {
  const r = await computeReliabilityForService(serviceId);
  await prisma.service.update({
    where: { id: serviceId },
    data: {
      perfectCount: r.perfect,
      partialCount: r.partial,
      failCount: r.fail,
      reliabilityFactor: r.factor,
      // legacy fields — keep populated until call sites migrate.
      reliabilityScore: r.legacyScore,
      reliabilitySamples: r.totalFinalized,
    },
  });
  return r;
}

/**
 * Plain-language chip for the UI breakdown row. Bucketed on the
 * factor (the operator-facing number) so the colour matches the
 * actual penalty being applied.
 */
export function reliabilityChip(
  factor: number | null,
): ReliabilityChip | null {
  if (factor === null) return null;
  if (factor >= 0.95) return { label: "TRÈS FIABLE", color: "green" };
  if (factor >= 0.85) return { label: "FIABLE", color: "blue" };
  if (factor >= 0.70) return { label: "MOYEN", color: "yellow" };
  return { label: "INSTABLE", color: "red" };
}
