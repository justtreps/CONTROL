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
import { acquireKeyForNewJob } from "@/lib/rapidapi/key-manager";
import { dispatchWorkerPair } from "@/lib/pool/dispatch";

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

  const apiKey = await acquireKeyForNewJob("instagram");
  const rapidApiKeyId = apiKey && apiKey.id !== -1 ? apiKey.id : null;

  const job = await prisma.poolJob.create({
    data: {
      jobType: "engagement_extract",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      rapidApiKeyId,
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Dual dispatch via shared helper (awaits grace window so the
  // fire-and-forget fetches truly land). Runner is the backup if
  // one of the two drops.
  const origin = new URL(req.url).origin;
  await dispatchWorkerPair({
    executeUrl: `${origin}/api/cron/pool-engagement-extract-execute?jobId=${job.id}`,
    runnerUrl: `${origin}/api/cron/pool-engagement-extract-runner?fromDispatcher=1`,
    cronSecret: process.env.CRON_SECRET,
    jobLabel: `engagement-extract job#${job.id}`,
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: "running",
    platform,
    count,
  });
}
