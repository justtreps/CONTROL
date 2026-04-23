// Re-kicks a stuck / errored job. Clones its stats checkpoint into a
// fresh PoolJob row so the work resumes without losing the cursor
// (doneSeedIds, processedAccountIds, etc.). The matching runner cron
// picks up the new row within 5 minutes, or we fire the execute
// worker directly for an instant resume.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const EXECUTE_ENDPOINT: Record<string, string> = {
  scrape: "/api/cron/pool-scrape-execute",
  health_check: "/api/cron/pool-health-check-execute",
  engagement_extract: "/api/cron/pool-engagement-extract-execute",
  engagement_fill: "/api/cron/pool-engagement-fill-execute",
};

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const source = await prisma.poolJob.findUnique({ where: { id } });
  if (!source) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Guard against relaunching a still-live job — operators can stop
  // it first, or relaunch a completed one if they really want a
  // re-run.
  if (!["stuck", "error", "stopped", "completed"].includes(source.status)) {
    return NextResponse.json(
      {
        error: "invalid_status",
        message: `Cannot relaunch a job in status="${source.status}" — stop it first`,
      },
      { status: 409 }
    );
  }

  // Clone stats so the new job resumes from the checkpoint (doneSeed
  // Ids, processedAccountIds, etc.). Wipe only the things that
  // should start fresh for the new run — errors + lastProgressAt.
  const clonedStats = (source.stats as Record<string, unknown> | null) ?? {};
  clonedStats.errors = [];
  clonedStats.lastProgressAt = undefined;

  const newJob = await prisma.poolJob.create({
    data: {
      jobType: source.jobType,
      platform: source.platform,
      trigger: "manual",
      status: "running",
      stats: clonedStats as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Fire-and-forget to the matching worker. If the dispatch misfires
  // the runner cron picks up the row within 5 min.
  const executePath = EXECUTE_ENDPOINT[source.jobType];
  if (executePath) {
    const origin = new URL(req.url).origin;
    const url = source.jobType === "scrape"
      || source.jobType === "health_check"
      || source.jobType === "engagement_extract"
      || source.jobType === "engagement_fill"
      ? `${origin}${executePath}?jobId=${newJob.id}`
      : `${origin}${executePath}`;
    void fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      keepalive: true,
    }).catch((e) => {
      console.error(
        `[relaunch] dispatch for ${source.jobType} job#${newJob.id} failed: ${(e as Error).message}`
      );
    });
  }

  return NextResponse.json({
    ok: true,
    newJobId: newJob.id,
    clonedFromJobId: source.id,
    jobType: source.jobType,
  });
}
