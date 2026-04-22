// Manual health-check trigger from the /pool "CONTRÔLE" button.
// Direct-run (same pattern as the cron endpoint) — the orchestrator
// no longer picks up jobType='health_check' since it capped throughput
// at ~24 checks/min. This runs inline with a 280s budget.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  initHealthStats,
  runHealthCheckTranche,
  maybeQueueAutoRefill,
} from "@/lib/pool/health-check";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 300;

const BUDGET_MS = 280_000;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
});

async function stopRequestedFor(jobId: number): Promise<boolean> {
  const row = await prisma.poolJob.findUnique({
    where: { id: jobId },
    select: { stopRequested: true },
  });
  return Boolean(row?.stopRequested);
}

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

  // Idempotent — same guard as the cron path.
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

  try {
    const { stats: finalStats } = await runHealthCheckTranche({
      stats: initial,
      budgetMs: BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });

    const stopped = await stopRequestedFor(job.id);
    await maybeQueueAutoRefill(finalStats);

    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: stopped ? "stopped" : "completed",
        stats: finalStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
        endedAt: new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: stopped ? "stopped" : "completed",
      stats: finalStats,
    });
  } catch (e) {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: "error",
        error: (e as Error).message.slice(0, 1000),
        endedAt: new Date(),
      },
    });
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
