// Manual trigger for the phase-1 engagement extract — reuse the
// follower pool to grow the engagement pool without re-scraping from
// seeds. Same fire-and-forget pattern as /api/pool/scrape: create the
// PoolJob row (jobType='engagement_extract'), dispatch to the
// execute worker, return jobId in <500ms. The runner cron picks up
// any orphan rows within 5 min.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initExtractStats } from "@/lib/pool/engagement-extract";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 10;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
  count: z.number().int().positive().max(10000).default(500),
});

export async function POST(req: Request) {
  const toggles = await getSystemToggles();
  if (!toggles.poolScrapeEnabled) {
    return NextResponse.json(
      {
        error: "pool_scrape_disabled",
        message: "Pool scrape is paused by the kill switch.",
      },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { platform, count } = parsed.data;

  // Idempotent — one engagement_extract in flight at a time.
  const active = await prisma.poolJob.findFirst({
    where: {
      jobType: "engagement_extract",
      status: { in: ["pending", "running"] },
    },
  });
  if (active) {
    return NextResponse.json({
      ok: true,
      skipped: "already_running",
      jobId: active.id,
      status: active.status,
    });
  }

  const initial = initExtractStats(platform, count);
  // Stamp poolType='engagement' on the stats JSON so the UI job
  // history labels it cleanly (· ENGAGEMENT suffix).
  (initial as unknown as { poolType?: string }).poolType = "engagement";

  const job = await prisma.poolJob.create({
    data: {
      jobType: "engagement_extract",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Dual dispatch — execute + runner in parallel. pickJobForRunner
  // on the runner side prevents double-execution.
  const origin = new URL(req.url).origin;
  const auth = { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };
  const executeUrl = `${origin}/api/cron/pool-engagement-extract-execute?jobId=${job.id}`;
  const runnerUrl = `${origin}/api/cron/pool-engagement-extract-runner`;
  void fetch(executeUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[engagement-extract] execute dispatch failed for job#${job.id}:`,
        (e as Error).message
      );
    }
  );
  void fetch(runnerUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[engagement-extract] runner backup dispatch failed for job#${job.id}:`,
        (e as Error).message
      );
    }
  );

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: "running",
    platform,
    count,
  });
}
