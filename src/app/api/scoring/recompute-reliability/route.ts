// One-shot — backfills Service.{perfectCount, partialCount, failCount,
// reliabilityFactor, reliabilityScore (legacy), reliabilitySamples
// (legacy)} for every active service that has at least one finalised
// TestOrder. Idempotent — the formula is deterministic and the
// onTestCompleted hook keeps the values fresh after each finalise
// once this lands.
//
// Why this endpoint exists: when the new factor-model columns ship,
// existing rows default to NULL / 0, which means scoring would treat
// every service as factor=1.0 (no penalty) until the next finalise.
// This backfill computes the factor for the entire catalog in a
// single SQL pass so the next /api/cron/scoring tick reflects the
// real penalty distribution.
//
// Auth: Bearer CRON_SECRET, same pattern as the other one-shots.
//
// Implementation: one $queryRaw classifies every finalised TestOrder
// as perfect / partial / fail and aggregates per service. UPDATE FROM
// (VALUES …) lands the result in chunks of 1 000 rows. Total
// wall-time ~3-8 s on the current catalog scale.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { RELIABILITY_MIN_SAMPLES } from "@/lib/scoring/reliability";

export const maxDuration = 60;

type ReliabilityRow = {
  serviceId: number;
  total: bigint;
  perfect: bigint;
  partial: bigint;
  fail: bigint;
};

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // Single-pass classification across the FULL finalised history per
  // service (no window — the factor model wants long-run signal).
  // For each TestOrder, take peak measurement past T+0 (or baseline if
  // none), bucket as perfect/partial/fail, then aggregate.
  const stats = await prisma.$queryRaw<ReliabilityRow[]>`
    WITH eligible AS (
      SELECT
        tor."serviceId" AS service_id,
        tor.id          AS order_id,
        tor."baselineCount" AS baseline,
        tor."targetQuantity" AS target
      FROM "TestOrder" tor
      WHERE tor.status IN ('completed', 'completed_partial')
    ),
    peak AS (
      SELECT
        e.service_id,
        e.order_id,
        e.baseline,
        e.target,
        COALESCE(
          (
            SELECT MAX(m."actualCount")
            FROM "Measurement" m
            WHERE m."testOrderId" = e.order_id
              AND m.checkpoint != 'T+0'
          ),
          e.baseline
        ) AS peak_count
      FROM eligible e
    ),
    classified AS (
      SELECT
        service_id,
        CASE
          WHEN (peak_count - baseline) >= GREATEST(target, 1) THEN 'perfect'
          WHEN (peak_count - baseline) > 0 THEN 'partial'
          ELSE 'fail'
        END AS bucket
      FROM peak
    )
    SELECT
      service_id   AS "serviceId",
      COUNT(*)::bigint                                                  AS total,
      SUM(CASE WHEN bucket = 'perfect' THEN 1 ELSE 0 END)::bigint AS perfect,
      SUM(CASE WHEN bucket = 'partial' THEN 1 ELSE 0 END)::bigint AS partial,
      SUM(CASE WHEN bucket = 'fail'    THEN 1 ELSE 0 END)::bigint AS fail
    FROM classified
    GROUP BY service_id
  `;

  // Compute factor in JS — same formula as the helper, kept here as
  // the single source of truth across the two code paths.
  type Persisted = {
    serviceId: number;
    perfect: number;
    partial: number;
    fail: number;
    total: number;
    factor: number | null;
    legacyScore: number | null;
  };
  const rows: Persisted[] = stats.map((r) => {
    const perfect = Number(r.perfect);
    const partial = Number(r.partial);
    const fail = Number(r.fail);
    const total = Number(r.total);
    let factor: number | null = null;
    if (total >= RELIABILITY_MIN_SAMPLES) {
      const ratio = perfect / total;
      factor = Math.round((0.5 + 0.5 * ratio) * 100) / 100;
    }
    const legacyScore =
      factor === null ? null : Math.round((factor - 0.5) * 20 * 10) / 10;
    return {
      serviceId: r.serviceId,
      perfect,
      partial,
      fail,
      total,
      factor,
      legacyScore,
    };
  });

  // Single UPDATE FROM (VALUES …) per chunk. We update both the new
  // columns AND the deprecated reliabilityScore/Samples so any code
  // still reading the legacy shape gets consistent values.
  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const tuples = chunk.map(
      (r) =>
        Prisma.sql`(${r.serviceId}::int, ${r.perfect}::int, ${r.partial}::int, ${r.fail}::int, ${r.factor}::float, ${r.legacyScore}::float, ${r.total}::int)`,
    );
    await prisma.$executeRaw`
      UPDATE "Service" s
      SET
        "perfectCount" = v.perfect,
        "partialCount" = v.partial,
        "failCount" = v.fail,
        "reliabilityFactor" = v.factor,
        "reliabilityScore" = v.legacy_score,
        "reliabilitySamples" = v.total
      FROM (VALUES ${Prisma.join(tuples)}) AS v(service_id, perfect, partial, fail, factor, legacy_score, total)
      WHERE s.id = v.service_id
    `;
    written += chunk.length;
  }

  // Services not in the result set have zero finalised tests — make
  // sure their counts are zeroed so the operator never sees stale
  // data after a re-run.
  if (rows.length > 0) {
    await prisma.service.updateMany({
      where: {
        AND: [
          {
            OR: [
              { reliabilityFactor: { not: null } },
              { perfectCount: { not: 0 } },
              { partialCount: { not: 0 } },
              { failCount: { not: 0 } },
              { reliabilitySamples: { not: 0 } },
            ],
          },
          { NOT: { id: { in: rows.map((r) => r.serviceId) } } },
        ],
      },
      data: {
        perfectCount: 0,
        partialCount: 0,
        failCount: 0,
        reliabilityFactor: null,
        reliabilityScore: null,
        reliabilitySamples: 0,
      },
    });
  }

  const withFactor = rows.filter((r) => r.factor !== null).length;
  const belowMinSamples = rows.length - withFactor;
  // Useful diagnostic: distribution of factors so the operator knows
  // how many services will see a meaningful score change.
  const factorBuckets = {
    "0.50-0.69": 0,
    "0.70-0.84": 0,
    "0.85-0.94": 0,
    "0.95-1.00": 0,
  };
  for (const r of rows) {
    if (r.factor === null) continue;
    if (r.factor < 0.7) factorBuckets["0.50-0.69"]++;
    else if (r.factor < 0.85) factorBuckets["0.70-0.84"]++;
    else if (r.factor < 0.95) factorBuckets["0.85-0.94"]++;
    else factorBuckets["0.95-1.00"]++;
  }

  return NextResponse.json({
    ok: true,
    written,
    candidates: rows.length,
    withFactor,
    belowMinSamples,
    factorBuckets,
    elapsedMs: Date.now() - t0,
    note: "currentScore is NOT updated by this endpoint. Run /api/cron/scoring (or wait ≤10 min) so the engine reads the new reliabilityFactor and writes ServiceScore rows reflecting the multiplier.",
  });
}

export const GET = POST;
