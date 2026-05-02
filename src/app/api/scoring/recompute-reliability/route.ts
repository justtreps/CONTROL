// One-shot — backfills Service.reliabilityScore + reliabilitySamples
// for every active service that has at least RELIABILITY_MIN_SAMPLES
// finalised TestOrders. Idempotent: re-running it is safe (the
// formula is deterministic) and the onTestCompleted hook keeps the
// values fresh after each finalise once this lands.
//
// Why this endpoint exists: when the column ships, Service rows
// default to reliabilityScore=null + reliabilitySamples=0, which
// would push every service to the bottom of the tier-internal sort
// (recomputeRanks treats null as -1). Without a backfill, the
// tie-breaker has zero practical effect until each service receives
// its next finalise. This endpoint ensures the ranking takes
// reliability into account immediately after deploy.
//
// Auth: Bearer CRON_SECRET, same pattern as the other one-shots
// under /api/pool/*.
//
// Implementation: V1 walked services one-by-one (~5 k × 50 ms = 4
// min) and timed out the lambda. V2 (this file) does it in two SQL
// statements — one CTE that classifies each TestOrder in the
// window, one UPDATE FROM (VALUES …) that lands every row in a
// single round-trip. Total wall-time ~3-8 s on the current catalog
// scale.
//
// recomputeRanks is NOT triggered inline — it walks every product ×
// candidate which adds another ~30 s and that's the next scoring
// cron's job. The operator can curl /api/scoring/campaign or wait
// 10 min for the next tick.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  RELIABILITY_WINDOW,
  RELIABILITY_MIN_SAMPLES,
} from "@/lib/scoring/reliability";

export const maxDuration = 60;

type ReliabilityRow = {
  serviceId: number;
  samples: bigint;
  perfect: bigint;
  partial: bigint;
  fail: bigint;
};

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // Single-pass classification:
  //   1. last_n  — keep the last RELIABILITY_WINDOW finalised orders
  //                per service via ROW_NUMBER() partitioned by
  //                serviceId, ordered by completedAt DESC.
  //   2. peak    — for each kept order, MAX(actualCount) over
  //                non-T+0 measurements (or baselineCount when no
  //                non-T+0 row exists, matching the JS helper).
  //   3. classified — bucketed perfect / partial / fail per the
  //                spec.
  //   4. final SELECT — counts per service, ready for UPDATE.
  //
  // NOTE: the JS helper falls back to baselineCount when the
  // measurements array is empty. Mirror that here with COALESCE on
  // the LEFT JOIN so a row with only T+0 measurements lands as
  // "fail" (delivered = 0), same as the per-service path.
  const stats = await prisma.$queryRaw<ReliabilityRow[]>`
    WITH last_n AS (
      SELECT
        tor."serviceId" AS service_id,
        tor.id          AS order_id,
        tor."baselineCount" AS baseline,
        tor."targetQuantity" AS target,
        ROW_NUMBER() OVER (
          PARTITION BY tor."serviceId"
          ORDER BY tor."completedAt" DESC NULLS LAST, tor.id DESC
        ) AS rn
      FROM "TestOrder" tor
      WHERE tor.status IN ('completed', 'completed_partial')
    ),
    eligible AS (
      SELECT * FROM last_n WHERE rn <= ${RELIABILITY_WINDOW}
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
      COUNT(*)::bigint                                                  AS samples,
      SUM(CASE WHEN bucket = 'perfect' THEN 1 ELSE 0 END)::bigint AS perfect,
      SUM(CASE WHEN bucket = 'partial' THEN 1 ELSE 0 END)::bigint AS partial,
      SUM(CASE WHEN bucket = 'fail'    THEN 1 ELSE 0 END)::bigint AS fail
    FROM classified
    GROUP BY service_id
  `;

  // Compute score in JS — same formula as the helper, kept here as
  // the single source of truth for both code paths.
  type Persisted = {
    serviceId: number;
    score: number | null;
    samples: number;
  };
  const rows: Persisted[] = stats.map((r) => {
    const perfect = Number(r.perfect);
    const partial = Number(r.partial);
    const fail = Number(r.fail);
    const samples = Number(r.samples);
    let score: number | null = null;
    if (samples >= RELIABILITY_MIN_SAMPLES) {
      const raw = (perfect - partial - 2 * fail) / RELIABILITY_WINDOW;
      const clamped = Math.max(0, Math.min(10, raw * 10));
      score = Math.round(clamped * 10) / 10;
    }
    return { serviceId: r.serviceId, score, samples };
  });

  // Single UPDATE FROM (VALUES …) — ~5 k rows in one round-trip
  // beats N individual prisma.service.update calls by 50-100×.
  // Chunk in 1 000-row pages so we don't hit the SQL parameter
  // limit (default ~32 k for postgres) and to keep memory bounded.
  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    // Build VALUES tuples manually — Prisma's templated query
    // supports inlining a Prisma.sql array via Prisma.join.
    const tuples = chunk.map(
      (r) =>
        Prisma.sql`(${r.serviceId}::int, ${r.score}::float, ${r.samples}::int)`,
    );
    await prisma.$executeRaw`
      UPDATE "Service" s
      SET
        "reliabilityScore" = v.score,
        "reliabilitySamples" = v.samples
      FROM (VALUES ${Prisma.join(tuples)}) AS v(service_id, score, samples)
      WHERE s.id = v.service_id
    `;
    written += chunk.length;
  }

  // Services that exist but have ZERO finalised TestOrders never
  // showed up in the SQL — make sure their reliabilitySamples is 0
  // (default already, but operator may run this after a manual
  // schema bump). Cheap targeted update.
  await prisma.service.updateMany({
    where: {
      AND: [
        { active: true },
        {
          OR: [
            { reliabilityScore: { not: null } },
            { reliabilitySamples: { not: 0 } },
          ],
        },
        {
          NOT: {
            id: { in: rows.map((r) => r.serviceId) },
          },
        },
      ],
    },
    data: { reliabilityScore: null, reliabilitySamples: 0 },
  });

  const elapsed = Date.now() - t0;
  return NextResponse.json({
    ok: true,
    written,
    candidates: rows.length,
    withScore: rows.filter((r) => r.score !== null).length,
    belowMinSamples: rows.filter((r) => r.score === null).length,
    elapsedMs: elapsed,
    note: "ranks not recomputed inline — fires next scoring cron tick (≤10 min) or curl /api/scoring/campaign manually.",
  });
}

export const GET = POST;
