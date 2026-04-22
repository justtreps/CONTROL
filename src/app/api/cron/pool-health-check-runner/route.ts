// Every 5 min: pick the oldest pending-or-running health-check job
// and drive a tranche against it. Safety net for POST /api/pool/
// health-check's fire-and-forget dispatch — if the initial request
// to /api/cron/pool-health-check-execute never made it (the keepalive
// fetch silently drops when the originating function dies too fast),
// this runner catches the orphan row on the next tick and resumes.
//
// Same pattern as pool-scrape-runner, minus auto_refill plumbing
// (health-check jobs only come from manual clicks or the 6h cron).
//
// Auth: Bearer CRON_SECRET. Honors SystemToggle.poolHealthcheckEnabled.
// One job per tick — if multiple are alive, the oldest wins.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import {
  runHealthCheckTranche,
  maybeQueueAutoRefill,
  type HealthStats,
} from "@/lib/pool/health-check";

export const maxDuration = 300;

const BUDGET_MS = 280_000;

async function stopRequestedFor(jobId: number): Promise<boolean> {
  const row = await prisma.poolJob.findUnique({
    where: { id: jobId },
    select: { stopRequested: true },
  });
  return Boolean(row?.stopRequested);
}

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const job = await prisma.poolJob.findFirst({
    where: {
      jobType: "health_check",
      status: { in: ["pending", "running"] },
    },
    orderBy: { startedAt: "asc" },
  });

  if (!job) {
    return NextResponse.json({ ok: true, skipped: "no_pending_health_check" });
  }

  if (job.status === "pending") {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
  }

  const stats = job.stats as unknown as HealthStats;

  try {
    const { stats: finalStats } = await runHealthCheckTranche({
      stats,
      budgetMs: BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });

    const stopped = await stopRequestedFor(job.id);
    await maybeQueueAutoRefill(finalStats);

    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: stopped ? "stopped" : "completed",
        stats:
          finalStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
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
      { error: (e as Error).message, jobId: job.id },
      { status: 500 }
    );
  }
}

export const GET = POST;
