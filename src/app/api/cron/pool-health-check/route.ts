// Direct-run health-check cron (replaces the old queue-for-orchestrator
// pattern). Creates a PoolJob row, runs runHealthCheckTranche straight
// through with a 280s budget, and updates the row on completion.
//
// Why direct-run:
//   The orchestrator gives each tranche only 8s per 60s cron tick
//   (~13% duty cycle). With concurrency 8 that capped our throughput
//   at ~24 checks/min — job #020 took 83 min to do 2008 checks.
//   Running directly here unlocks the full 300s function budget and
//   pushes throughput to ~300+ checks/min.
//
// Auth: Bearer CRON_SECRET (Vercel Cron sets it automatically).
// Kill switch: honors SystemToggle.poolHealthcheckEnabled.
// Idempotency: if a health_check job is already running, we skip.
//              stopRequested polling checks PoolJob.stopRequested
//              every tranche iteration so manual STOP still works.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "@/lib/pool/config";
import {
  initHealthStats,
  runHealthCheckTranche,
  maybeQueueAutoRefill,
} from "@/lib/pool/health-check";
import { finalizeTrancheStatus, startJobHeartbeat } from "@/lib/pool/job-health";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 300;

const BUDGET_MS = 280_000; // 280s of actual work — leaves 20s headroom

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

  const cfg = await getPoolConfig();
  if (!cfg.healthCheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  // Idempotent — one health-check in flight at a time.
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

  const initial = initHealthStats("both");
  const job = await prisma.poolJob.create({
    data: {
      jobType: "health_check",
      platform: null,
      trigger: "cron",
      status: "running",
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  const hb = startJobHeartbeat({
    jobId: job.id,
    getStats: () => initial as unknown as Record<string, unknown>,
  });

  try {
    const { done, stats: finalStats } = await runHealthCheckTranche({
      stats: initial,
      budgetMs: BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });

    const stopped = await stopRequestedFor(job.id);
    if (done) await maybeQueueAutoRefill(finalStats);

    const { finalStatus, stuckReason } = finalizeTrancheStatus({
      job,
      beforeStats: initial as unknown as Record<string, unknown>,
      afterStats: finalStats as unknown as Record<string, unknown>,
      cfg,
      stopped,
      done,
    });

    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        stats: finalStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
        error: stuckReason ?? undefined,
        endedAt: finalStatus === "running" ? null : new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: finalStatus,
      stuckReason,
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
  } finally {
    await hb.stop();
  }
}

export const GET = POST;
