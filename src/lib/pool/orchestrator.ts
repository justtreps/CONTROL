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

// Hard ceiling: any job that has sat in 'running' this long with zero
// work done is presumed dead (fire-and-forget dispatch misfired, worker
// crashed before its first write, etc.). 30 min is well beyond the
// longest normal tranche (scrape + health both cap at 280s per run) so
// we won't false-positive a slow-but-alive job.
const STALE_NO_PROGRESS_MS = 30 * 60 * 1000;

// Walks every running job and flips the obvious zombies to 'error' so
// downstream idempotency gates (e.g. the health-check cron's
// "skip if one already running" check) don't stay pinned on a dead row.
// Runs at the top of every orchestrator tick — cheap query, same 60s
// cadence as everything else.
export async function runStaleJobWatchdog(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_NO_PROGRESS_MS);
  const stale = await prisma.poolJob.findMany({
    where: {
      status: "running",
      startedAt: { lt: cutoff },
    },
    select: { id: true, jobType: true, startedAt: true, stats: true },
  });

  let flagged = 0;
  for (const j of stale) {
    const s = (j.stats as Record<string, number | undefined> | null) ?? {};
    const checked = s.checked ?? 0;
    const callsUsed = s.callsUsed ?? 0;
    const addedA = s.addedA ?? 0;
    const addedB = s.addedB ?? 0;

    // Progress heuristic per job type. Any non-zero progress signal
    // means the worker ran at least one iteration — leave it alone
    // (the normal runners will either finish it or pick it up again
    // on the next cron tick).
    const isNoProgress =
      j.jobType === "health_check"
        ? checked === 0 && callsUsed === 0
        : j.jobType === "scrape"
          ? addedA + addedB === 0 && callsUsed === 0
          : false; // cleanup jobs are fast — unknown types: leave alone

    if (!isNoProgress) continue;

    const ageMin = Math.floor(
      (Date.now() - j.startedAt.getTime()) / 60_000
    );
    await prisma.poolJob.update({
      where: { id: j.id },
      data: {
        status: "error",
        error: `stale_no_progress: ${j.jobType} running ${ageMin}min with no checks/calls — fire-and-forget dispatch likely failed`,
        endedAt: new Date(),
      },
    });
    flagged++;
  }
  return flagged;
}

export async function runOrchestratorTick(): Promise<OrchestratorResult> {
  // Watchdog first — unblocks idempotency gates if any health-check
  // or scrape job has been dead-in-the-water for 30+ min. Cheap query
  // that runs before anything else so a genuinely stuck row doesn't
  // keep masking itself.
  const flagged = await runStaleJobWatchdog();

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
      ...(flagged ? { staleFlagged: flagged } : {}),
      ...(disabledTypes.length
        ? { skipped: `paused_by_toggle:${disabledTypes.join(",")}` }
        : {}),
    } as OrchestratorResult & { skipped?: string; staleFlagged?: number };
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
