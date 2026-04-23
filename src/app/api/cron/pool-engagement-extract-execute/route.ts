// Worker for a single engagement_extract PoolJob row. Called via
// fire-and-forget from POST /api/pool/engagement-extract; the runner
// cron is the safety net for misfires.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
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

  const jobId = Number(new URL(req.url).searchParams.get("jobId"));
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid_jobId" }, { status: 400 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolScrapeEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const job = await prisma.poolJob.findUnique({ where: { id: jobId } });
  if (!job || job.jobType !== "engagement_extract") {
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

  const stats = job.stats as unknown as ExtractStats;

  try {
    const { done, stats: finalStats } = await runEngagementExtractTranche({
      stats,
      budgetMs: BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });

    const stopped = await stopRequestedFor(job.id);
    const finalStatus = stopped ? "stopped" : done ? "completed" : "running";

    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        stats:
          finalStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
        endedAt: finalStatus === "running" ? null : new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: finalStatus,
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
