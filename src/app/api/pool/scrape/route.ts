// Manual scrape trigger (the "LANCER LE SCRAPE" button in Zone 2).
// Direct-run: creates the PoolJob row ourselves, runs a single
// tranche inline with a 280s budget, returns the outcome. If the
// target isn't reached within that budget the job stays 'running'
// and /api/cron/pool-scrape-runner resumes it every 5 min using
// the stats-based checkpoint in the PoolJob row.
//
// Pre-existing route shape kept (POST { platform, count }) so the
// UI doesn't need a change. Response gains `finalStatus` + `stats`
// so PoolUnifiedActions can toast results.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initScrapeStats } from "@/lib/pool/scraper";
import { runScrapeJobTranche } from "@/lib/pool/scrape-runner";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 300;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
  count: z.number().int().positive().max(10000).default(1000),
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

  const initial = initScrapeStats(platform, count);
  const job = await prisma.poolJob.create({
    data: {
      jobType: "scrape",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

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
