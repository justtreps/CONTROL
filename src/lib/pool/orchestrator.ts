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
import { getSystemToggles } from "@/lib/system/toggles";

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
  // Kill-switch gate: skip any job whose subsystem is paused. Those
  // jobs stay in 'pending' forever until the toggle is flipped back on
  // — that's the whole point of the kill switch.
  const toggles = await getSystemToggles();
  const disabledTypes: string[] = [];
  if (!toggles.poolScrapeEnabled) disabledTypes.push("scrape");
  if (!toggles.poolHealthcheckEnabled) disabledTypes.push("health_check");

  // Both health_check AND scrape now run directly via their own
  // cron endpoints (300s budget, resumable across ticks) after we
  // measured the orchestrator's 8s per 60s budget capping throughput
  // at 13% duty cycle. We exclude both jobType values here so the
  // orchestrator doesn't double-process a row that the direct-run
  // crons are already handling. Only 'cleanup' still flows through
  // here (and it's cheap).
  const excluded = new Set<string>([
    ...disabledTypes,
    "health_check",
    "scrape",
  ]);

  // Pick the oldest non-terminal job whose subsystem is still enabled.
  // 'running' rows also get picked up in case a previous tick died
  // mid-tranche — the tranche runners are idempotent (they read from
  // DB + the checkpoint in job.stats).
  const job = await prisma.poolJob.findFirst({
    where: {
      status: { in: ["pending", "running"] },
      jobType: { notIn: Array.from(excluded) },
    },
    orderBy: { startedAt: "asc" },
  });
  if (!job) {
    return {
      ran: false,
      ...(disabledTypes.length
        ? { skipped: `paused_by_toggle:${disabledTypes.join(",")}` }
        : {}),
    } as OrchestratorResult & { skipped?: string };
  }

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
