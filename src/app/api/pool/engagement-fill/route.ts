// Single unified "grow the engagement pool" endpoint. Fire-and-forget
// dispatcher for the PoolJob(engagement_fill) row; the worker at
// /api/cron/pool-engagement-fill-execute runs phase 1 (extract) then
// automatically chains to phase 2 (seed scrape) if the target isn't
// reached yet.
//
// Same ergonomics as /api/pool/scrape: click returns in <500ms with
// jobId, the runner cron is the safety net for keepalive misfires.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initFillStats } from "@/lib/pool/engagement-fill";
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

  // Idempotent — one fill in flight at a time.
  const active = await prisma.poolJob.findFirst({
    where: {
      jobType: "engagement_fill",
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

  const initial = initFillStats(platform, count);

  const job = await prisma.poolJob.create({
    data: {
      jobType: "engagement_fill",
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
  const executeUrl = `${origin}/api/cron/pool-engagement-fill-execute?jobId=${job.id}`;
  const runnerUrl = `${origin}/api/cron/pool-engagement-fill-runner?fromDispatcher=1`;
  void fetch(executeUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[engagement-fill] execute dispatch failed for job#${job.id}:`,
        (e as Error).message
      );
    }
  );
  void fetch(runnerUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[engagement-fill] runner backup dispatch failed for job#${job.id}:`,
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
