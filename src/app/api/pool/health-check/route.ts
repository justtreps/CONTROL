// Manual health-check trigger (the "CONTRÔLE" button in Zone 2 and
// the "LANCER VÉRIFICATION MAINTENANT" button in the seeds section).
//
// Same fix as /api/pool/scrape: the old inline 280s run hung the
// LoadingScreen curtain for up to 5 min. Now we create the PoolJob
// row in status='running', fire a non-awaited fetch to /api/cron/
// pool-health-check-execute?jobId=N, and return the jobId in <500ms.
// UI closes the curtain immediately; the new job shows in Active
// Jobs and progresses via the triggered separate invocation.
//
// Fallback: the 6-hour /api/cron/pool-health-check scheduled cron
// still runs its own sweep. If the fire-and-forget misfires, the
// job stays 'running' with zero progress until the user clicks
// again OR a new check is scheduled.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initHealthStats } from "@/lib/pool/health-check";
import { getSystemToggles } from "@/lib/system/toggles";
import { acquireKeyForNewJob } from "@/lib/rapidapi/key-manager";
import { dispatchWorkerPair } from "@/lib/pool/dispatch";

export const maxDuration = 10;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
  // Which pool to sweep. When set, only TestAccount rows whose
  // accountType matches get picked up — the other pool stays idle.
  // Legacy callers (cron, manual calls pre-universe-switch) omit
  // poolType and get the old behavior (both pools).
  poolType: z.enum(["follower", "engagement"]).optional(),
});

export async function POST(req: Request) {
  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json(
      {
        error: "pool_healthcheck_disabled",
        message: "Pool health-check is paused by the kill switch.",
      },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { platform, poolType } = parsed.data;

  // Idempotent — one health-check in flight at a time PER pool. We
  // key on the stats.poolType so the user can fire a follower check
  // and an engagement check in parallel (different universes) but
  // not two of the same.
  const activeList = await prisma.poolJob.findMany({
    where: {
      jobType: "health_check",
      status: { in: ["pending", "running"] },
    },
  });
  const active = activeList.find((j) => {
    const jobPool = (j.stats as unknown as { poolType?: string } | null)
      ?.poolType;
    if (poolType) return jobPool === poolType;
    // Legacy caller with no poolType collides with any running job,
    // same as before.
    return true;
  });
  if (active) {
    return NextResponse.json({
      ok: true,
      skipped: "already_running",
      jobId: active.id,
      status: active.status,
    });
  }

  const initial = initHealthStats(platform);
  if (poolType) {
    (initial as unknown as { poolType?: string }).poolType = poolType;
  }

  const apiKey = await acquireKeyForNewJob("instagram");
  const rapidApiKeyId = apiKey && apiKey.id !== -1 ? apiKey.id : null;

  const job = await prisma.poolJob.create({
    data: {
      jobType: "health_check",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      rapidApiKeyId,
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Dual dispatch via shared helper (awaits grace window so the
  // fire-and-forget fetches truly land). Runner is the backup if
  // one of the two drops.
  const origin = new URL(req.url).origin;
  await dispatchWorkerPair({
    executeUrl: `${origin}/api/cron/pool-health-check-execute?jobId=${job.id}`,
    runnerUrl: `${origin}/api/cron/pool-health-check-runner?fromDispatcher=1`,
    cronSecret: process.env.CRON_SECRET,
    jobLabel: `health-check job#${job.id}`,
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: "running",
    platform,
  });
}
