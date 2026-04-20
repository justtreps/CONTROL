// Pool orchestrator — the tranche runner.
//
// Called every minute by the Vercel cron /api/cron/pool-orchestrator.
// Responsibilities:
//   1. Find the oldest pending-or-running job
//   2. Mark it running, take a stats snapshot
//   3. Delegate to the right tranche runner (scrape / health-check)
//      with a ~8s budget and a stopRequested() probe
//   4. Persist updated stats + either mark the job done, stopped, or
//      leave it pending for the next tick
//
// Survives Vercel timeouts because each tranche is intentionally
// short. Never awaits long-running work past the budget.

import { prisma } from "@/lib/prisma";
import {
  runScrapeTranche,
  initScrapeStats,
  type ScrapeStats,
} from "./scraper";
import {
  runHealthCheckTranche,
  initHealthStats,
  maybeQueueAutoRefill,
  type HealthStats,
} from "./health-check";
import { archiveOldRecords } from "./cleanup";

const BUDGET_MS = 8_000; // keep well under Vercel 10s hobby limit

type OrchestratorResult = {
  ran: boolean;
  jobId?: number;
  jobType?: string;
  finalStatus?: string;
  stats?: unknown;
};

async function stopRequestedFor(jobId: number): Promise<boolean> {
  const row = await prisma.poolJob.findUnique({
    where: { id: jobId },
    select: { stopRequested: true },
  });
  return Boolean(row?.stopRequested);
}

export async function runOrchestratorTick(): Promise<OrchestratorResult> {
  // Pick the oldest non-terminal job. 'running' rows also get picked up
  // in case a previous tick died mid-tranche — the tranche runners are
  // idempotent (they read from DB + the checkpoint in job.stats).
  const job = await prisma.poolJob.findFirst({
    where: { status: { in: ["pending", "running"] } },
    orderBy: { startedAt: "asc" },
  });
  if (!job) return { ran: false };

  if (job.status === "pending") {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
  }

  const shouldStop = () => stopRequestedFor(job.id);

  try {
    if (job.jobType === "scrape") {
      let stats = (job.stats as ScrapeStats | null) ?? null;
      if (!stats) {
        const platform =
          (job.platform as "instagram" | "tiktok" | null) ?? "both";
        stats = initScrapeStats(platform, 1000);
      }
      const { done, stats: updated } = await runScrapeTranche({
        stats,
        budgetMs: BUDGET_MS,
        stopRequested: shouldStop,
      });

      const stopped = await shouldStop();
      const finalStatus = stopped ? "stopped" : done ? "completed" : "running";
      await prisma.poolJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          stats: updated as unknown as import("@prisma/client").Prisma.InputJsonValue,
          endedAt: finalStatus === "running" ? null : new Date(),
        },
      });
      return { ran: true, jobId: job.id, jobType: "scrape", finalStatus, stats: updated };
    }

    if (job.jobType === "health_check") {
      let stats = (job.stats as HealthStats | null) ?? null;
      if (!stats) {
        const platform =
          (job.platform as "instagram" | "tiktok" | null) ?? "both";
        stats = initHealthStats(platform);
      }
      const { done, stats: updated } = await runHealthCheckTranche({
        stats,
        budgetMs: BUDGET_MS,
        stopRequested: shouldStop,
      });

      if (done) await maybeQueueAutoRefill(updated);

      const stopped = await shouldStop();
      const finalStatus = stopped ? "stopped" : done ? "completed" : "running";
      await prisma.poolJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          stats: updated as unknown as import("@prisma/client").Prisma.InputJsonValue,
          endedAt: finalStatus === "running" ? null : new Date(),
        },
      });
      return {
        ran: true,
        jobId: job.id,
        jobType: "health_check",
        finalStatus,
        stats: updated,
      };
    }

    if (job.jobType === "cleanup") {
      const stats = await archiveOldRecords();
      await prisma.poolJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          stats: stats as unknown as import("@prisma/client").Prisma.InputJsonValue,
          endedAt: new Date(),
        },
      });
      return { ran: true, jobId: job.id, jobType: "cleanup", finalStatus: "completed", stats };
    }

    // Unknown job type — mark error so we don't loop forever.
    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: "error",
        error: `unknown jobType: ${job.jobType}`,
        endedAt: new Date(),
      },
    });
    return { ran: true, jobId: job.id, finalStatus: "error" };
  } catch (e) {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: "error",
        error: (e as Error).message.slice(0, 1000),
        endedAt: new Date(),
      },
    });
    return { ran: true, jobId: job.id, finalStatus: "error" };
  }
}
