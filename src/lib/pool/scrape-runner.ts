// Direct-run entrypoint for scrape jobs. Mirrors the health-check
// pattern we shipped last commit: the caller creates/picks a PoolJob
// row, hands us the row, and we run runScrapeTranche with a 280s
// budget, polling PoolJob.stopRequested for UI-driven cancellation.
//
// Two call sites:
//   • /api/pool/scrape       — manual trigger, creates a fresh job
//   • /api/cron/pool-scrape-runner — every 5 min, picks the oldest
//     pending/running scrape job (includes auto-refill rows queued
//     by maybeQueueAutoRefill) and runs a tranche. If the tranche
//     hits deadline before done:true, the job stays 'running' and
//     the next cron tick resumes via stats-based checkpoint.
//
// We deliberately do NOT touch src/lib/pool/scraper.ts internals —
// we just wrap runScrapeTranche with a direct-run harness, same as
// the health-check refactor.

import { prisma } from "@/lib/prisma";
import {
  runScrapeTranche,
  type ScrapeStats,
} from "./scraper";
import { getPoolConfig } from "./config";
import { finalizeTrancheStatus, startJobHeartbeat } from "./job-health";
import type { PoolJob } from "@prisma/client";

export const SCRAPE_BUDGET_MS = 280_000;

async function stopRequestedFor(jobId: number): Promise<boolean> {
  const row = await prisma.poolJob.findUnique({
    where: { id: jobId },
    select: { stopRequested: true },
  });
  return Boolean(row?.stopRequested);
}

export type ScrapeRunResult = {
  jobId: number;
  finalStatus: string;
  stats: ScrapeStats;
};

// Runs a single tranche for an existing PoolJob row. Caller is
// responsible for having created/picked the row and set its status
// to 'running' before calling this.
export async function runScrapeJobTranche(
  job: Pick<PoolJob, "id" | "stats" | "jobType" | "startedAt">
): Promise<ScrapeRunResult> {
  const beforeStats = job.stats as Record<string, unknown> | null;
  const stats = job.stats as unknown as ScrapeStats;
  const hb = startJobHeartbeat({
    jobId: job.id,
    getStats: () => stats as unknown as Record<string, unknown>,
  });
  try {
    const { done, stats: updated } = await runScrapeTranche({
      stats,
      budgetMs: SCRAPE_BUDGET_MS,
      stopRequested: () => stopRequestedFor(job.id),
    });
    const stopped = await stopRequestedFor(job.id);
    const cfg = await getPoolConfig();
    const { finalStatus, stuckReason } = finalizeTrancheStatus({
      job,
      beforeStats,
      afterStats: updated as unknown as Record<string, unknown>,
      cfg,
      stopped,
      done,
    });
    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        stats:
          updated as unknown as import("@prisma/client").Prisma.InputJsonValue,
        error: stuckReason ?? undefined,
        // only stamp endedAt when the job is actually terminal
        endedAt: finalStatus === "running" ? null : new Date(),
      },
    });
    return { jobId: job.id, finalStatus, stats: updated };
  } catch (e) {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: {
        status: "error",
        error: (e as Error).message.slice(0, 1000),
        endedAt: new Date(),
      },
    });
    throw e;
  } finally {
    await hb.stop();
  }
}
