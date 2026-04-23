// Every 5 min: safety net for engagement_extract jobs. Picks the
// oldest pending/running row and drives a tranche — mirrors
// pool-scrape-runner and pool-health-check-runner. Catches any orphan
// row whose fire-and-forget dispatch from /api/pool/engagement-
// extract silently dropped.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { getPoolConfig } from "@/lib/pool/config";
import { finalizeTrancheStatus, startJobHeartbeat } from "@/lib/pool/job-health";
import {
  runEngagementExtractTranche,
  type ExtractStats,
} from "@/lib/pool/engagement-extract";

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

  const job = await prisma.poolJob.findFirst({
    where: {
      jobType: "engagement_extract",
      status: { in: ["pending", "running"] },
    },
    orderBy: { startedAt: "asc" },
  });

  if (!job) {
    return NextResponse.json({ ok: true, skipped: "no_pending_extract" });
  }

  if (job.status === "pending") {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
  }

  const beforeStats = job.stats as Record<string, unknown> | null;
  const stats = job.stats as unknown as ExtractStats;
  const hb = startJobHeartbeat({
    jobId: job.id,
    getStats: () => stats as unknown as Record<string, unknown>,
  });

  try {
    const { done, stats: finalStats } = await runEngagementExtractTranche({
      stats,
      budgetMs: BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });

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
