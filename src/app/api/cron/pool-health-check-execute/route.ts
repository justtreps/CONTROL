// Executes ONE specific health-check PoolJob row by id. Called via
// fire-and-forget fetch from POST /api/pool/health-check so the
// manual button returns instantly while the 280s tranche runs in a
// separate Vercel invocation.
//
// Auth: Bearer CRON_SECRET. URL: ?jobId=<n>.
// The existing /api/cron/pool-health-check (unchanged) is still the
// scheduled 6-hour sweep — it creates its own job and runs it.
// This endpoint is strictly the "execute a specific row" worker.

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

  const jobId = Number(new URL(req.url).searchParams.get("jobId"));
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid_jobId" }, { status: 400 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const job = await prisma.poolJob.findUnique({ where: { id: jobId } });
  if (!job || job.jobType !== "health_check") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (["completed", "stopped", "error"].includes(job.status)) {
    return NextResponse.json({
      ok: true,
      skipped: "already_terminal",
      status: job.status,
    });
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
