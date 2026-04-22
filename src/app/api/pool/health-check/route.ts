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

export const maxDuration = 10;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
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
  const { platform } = parsed.data;

  // Idempotent — one health-check in flight at a time. If one is
  // already running, return its jobId so the UI can show progress.
  const active = await prisma.poolJob.findFirst({
    where: {
      jobType: "health_check",
      status: { in: ["pending", "running"] },
    },
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
  const job = await prisma.poolJob.create({
    data: {
      jobType: "health_check",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Fire-and-forget to the execute worker (separate Vercel invocation,
  // 300s maxDuration).
  const origin = new URL(req.url).origin;
  const executeUrl = `${origin}/api/cron/pool-health-check-execute?jobId=${job.id}`;
  void fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    keepalive: true,
  }).catch((e) => {
    console.error(
      `[health-check] failed to dispatch execute for job#${job.id}:`,
      (e as Error).message
    );
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: "running",
    platform,
  });
}
