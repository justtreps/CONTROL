// Every 5 min: pick the oldest pending-or-running scrape job and
// run a 280s tranche against it. Replaces the old orchestrator path
// for scrape jobs — the orchestrator's 8s budget per 60s tick was
// capping throughput at ~13% duty cycle (same bug we fixed for
// health-check last commit).
//
// Covers both trigger types:
//   • trigger='manual'      — handled inline by /api/pool/scrape on
//                             first click, but a resumed row may
//                             land here if the initial 280s didn't
//                             reach `done: true`
//   • trigger='auto_refill' — queued as 'pending' by maybeQueue
//                             AutoRefill() inside the health-check
//                             cron. This cron drains that queue.
//
// Auth: Bearer CRON_SECRET. Honors SystemToggle.poolScrapeEnabled.
// One job per tick — if multiple are pending, they're drained in
// oldest-first order across successive ticks.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { runScrapeJobTranche } from "@/lib/pool/scrape-runner";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolScrapeEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  // Pick the oldest scrape job that still needs work. `running`
  // rows are resumes of a previous tick that didn't reach done.
  const job = await prisma.poolJob.findFirst({
    where: {
      jobType: "scrape",
      status: { in: ["pending", "running"] },
    },
    orderBy: { startedAt: "asc" },
  });

  if (!job) {
    return NextResponse.json({ ok: true, skipped: "no_pending_scrape" });
  }

  // Mark 'running' (idempotent) so the UI shows activity + the job
  // has a non-null transition point if it was freshly pending.
  if (job.status === "pending") {
    await prisma.poolJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
  }

  try {
    const result = await runScrapeJobTranche(job);
    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      finalStatus: result.finalStatus,
      stats: result.stats,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, jobId: job.id },
      { status: 500 }
    );
  }
}

export const GET = POST;
