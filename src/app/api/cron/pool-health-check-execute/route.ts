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
import { getPoolConfig } from "@/lib/pool/config";
import { finalizeTrancheStatus, startJobHeartbeat } from "@/lib/pool/job-health";
import { withAssignedKey } from "@/lib/rapidapi/key-manager";
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

  // Deep clone — see scrape-runner.ts for the reference-aliasing
  // bug this avoids (false stale_no_progress stucks).
  const beforeStats =
    (structuredClone(job.stats) as Record<string, unknown> | null) ?? {};
  const stats = job.stats as unknown as HealthStats;
  const hb = startJobHeartbeat({
    jobId: job.id,
    getStats: () => stats as unknown as Record<string, unknown>,
  });

  try {
    const { done, stats: finalStats } = await withAssignedKey(job, () =>
      runHealthCheckTranche({
        stats,
        budgetMs: BUDGET_MS,
        stopRequested: () => stopRequestedFor(job.id),
      })
    );

    const stopped = await stopRequestedFor(job.id);
    if (done) await maybeQueueAutoRefill(finalStats);

    const cfg = await getPoolConfig();
    const { finalStatus, stuckReason } = finalizeTrancheStatus({
      job,
      beforeStats,
      afterStats: finalStats as unknown as Record<string, unknown>,
      cfg,
      stopped,
      done,
    });

    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        stats:
          finalStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
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
      { error: (e as Error).message, jobId: job.id },
      { status: 500 }
    );
  } finally {
    await hb.stop();
  }
}

export const GET = POST;
