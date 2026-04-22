// Executes ONE specific scrape PoolJob row by id. Called via a
// fire-and-forget fetch from POST /api/pool/scrape so the manual
// button can return < 500ms while the 280s tranche runs in a
// separate Vercel invocation (and the original curtain animation
// no longer hangs the UI for 5 minutes).
//
// Auth: Bearer CRON_SECRET (route sits under /api/cron so middleware
// doesn't session-gate it). URL: ?jobId=<n>.
//
// Idempotent: if the job is already terminal (completed/stopped/
// error) we skip and return the existing status. If it's 'pending'
// we flip to 'running' before the tranche.

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

  const jobId = Number(new URL(req.url).searchParams.get("jobId"));
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid_jobId" }, { status: 400 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolScrapeEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const job = await prisma.poolJob.findUnique({ where: { id: jobId } });
  if (!job || job.jobType !== "scrape") {
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
