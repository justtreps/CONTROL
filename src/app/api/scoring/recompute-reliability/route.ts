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
// Cost: 1 SELECT + 1 UPDATE per active service. Cap at 60s
// maxDuration — the helper does ≤ 10 row-fetch per service so
// even ~5000 services land under budget. If we need to scale past
// that, swap to a single $queryRaw computing all services in one
// pass.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { computeReliabilityForService } from "@/lib/scoring/reliability";
import { recomputeRanks } from "@/lib/scoring";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Snapshot the candidate set up front — services that have ANY
  // finalised TestOrder. Skipping fully untested services saves a
  // DB round-trip per row (the helper would just return null/0).
  const services = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: {
        some: {
          status: { in: ["completed", "completed_partial"] },
        },
      },
    },
    select: { id: true },
  });

  let withScore = 0;
  let belowMinSamples = 0;
  const errors: Array<{ serviceId: number; reason: string }> = [];

  // Sequential — keeps prisma connection use bounded. Should
  // complete inside maxDuration for the current scale (~3-5k
  // active services × ≤ 50 ms each).
  for (const s of services) {
    try {
      const r = await computeReliabilityForService(s.id);
      await prisma.service.update({
        where: { id: s.id },
        data: {
          reliabilityScore: r.score,
          reliabilitySamples: r.samples,
        },
      });
      if (r.score === null) belowMinSamples++;
      else withScore++;
    } catch (e) {
      errors.push({
        serviceId: s.id,
        reason: (e as Error).message.slice(0, 120),
      });
    }
  }

  // Trigger a rank recompute so the new tie-breaker propagates to
  // ProductServiceCandidate.rank in the same call. Otherwise the
  // operator sees fresh reliability values but stale ranks until the
  // next scoring cron tick.
  let rankError: string | null = null;
  try {
    await recomputeRanks();
  } catch (e) {
    rankError = (e as Error).message.slice(0, 200);
  }

  return NextResponse.json({
    ok: true,
    candidates: services.length,
    withScore,
    belowMinSamples,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    rankRecomputeError: rankError,
  });
}

export const GET = POST;
