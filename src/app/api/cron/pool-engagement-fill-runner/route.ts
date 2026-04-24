// Every 5 min: safety net for engagement_fill jobs — picks the oldest
// pending/running row and drives a tranche. Same pattern as the other
// pool-*-runner crons. Catches orphan rows whose fire-and-forget
// dispatch from /api/pool/engagement-fill silently dropped.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { getPoolConfig } from "@/lib/pool/config";
import { finalizeTrancheStatus, startJobHeartbeat, pickJobForRunner } from "@/lib/pool/job-health";
import { withAssignedKey } from "@/lib/rapidapi/key-manager";
import {
  runEngagementFillTranche,
  syncFillCounters,
  type FillStats,
} from "@/lib/pool/engagement-fill";

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
  if (!toggles.poolScrapeEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const fromDispatcher =
    new URL(req.url).searchParams.get("fromDispatcher") === "1";
  const job = await pickJobForRunner("engagement_fill", {
    waitOnGrace: fromDispatcher,
  });
  if (!job) {
    return NextResponse.json({ ok: true, skipped: "no_pending_fill" });
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
  const stats = job.stats as unknown as FillStats;
  const hb = startJobHeartbeat({
    jobId: job.id,
    getStats: () =>
      syncFillCounters(stats) as unknown as Record<string, unknown>,
  });

  try {
    const { done, stats: finalStats } = await withAssignedKey(job, () =>
      runEngagementFillTranche({
        stats,
        budgetMs: BUDGET_MS,
        stopRequested: () => stopRequestedFor(job.id),
      })
    );

    const stopped = await stopRequestedFor(job.id);
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
