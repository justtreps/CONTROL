// Manual scrape trigger (the "CHERCHER DE NOUVEAUX COMPTES" button).
//
// Before: this endpoint ran runScrapeJobTranche inline with a 280s
// budget — the LoadingScreen curtain stayed up for up to 5 minutes
// while the user was locked out of the app. Terrible UX.
//
// Now: create the PoolJob row in status='running', fire a
// non-awaited internal fetch to /api/cron/pool-scrape-execute?jobId=N
// so a fresh Vercel invocation picks up the work, and return the
// jobId in <500ms. UI closes the curtain immediately and the new
// job shows up in the Active Jobs card.
//
// Reliability: if the fire-and-forget fetch fails to reach the
// execute endpoint (rare — Vercel edge usually dispatches the TCP
// packet before the caller's function terminates), the
// /api/cron/pool-scrape-runner cron runs every 5 min and drains
// any 'running' job it finds. So the job ALWAYS eventually gets
// processed, just with a 0-5 min delay if the hot path misfires.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initScrapeStats } from "@/lib/pool/scraper";
import { getSystemToggles } from "@/lib/system/toggles";
import { acquireKeyForNewJob } from "@/lib/rapidapi/key-manager";

// The outer endpoint returns fast; we don't need 300s here. The
// heavy work runs in /api/cron/pool-scrape-execute (maxDuration 300).
export const maxDuration = 10;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
  count: z.number().int().positive().max(10000).default(1000),
  // Which universe to grow. When set, the scraper enforces an
  // override in addition to the classic engagementPoolEnabled gate:
  //   follower    → only keep mediaCount == 0 candidates
  //   engagement  → only keep mediaCount >= engagementPostsMin
  // Legacy callers that omit poolType keep the previous behavior
  // (rely on engagementPoolEnabled + mediaCount routing).
  poolType: z.enum(["follower", "engagement"]).optional(),
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
  const { platform, count, poolType } = parsed.data;

  const initial = initScrapeStats(platform, count);
  if (poolType) {
    // Stash on the stats JSON rather than adding a dedicated PoolJob
    // column — zero-migration path, and the scraper already reads
    // stats at tranche start.
    (initial as unknown as { poolType?: string }).poolType = poolType;
  }

  // Round-robin pick of the RapidAPI key this job will use. If the
  // table is empty the manager falls back to the env var (id=-1
  // sentinel), which we don't persist on PoolJob.
  const apiKey = await acquireKeyForNewJob("instagram");
  const rapidApiKeyId = apiKey && apiKey.id !== -1 ? apiKey.id : null;

  const job = await prisma.poolJob.create({
    data: {
      jobType: "scrape",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "running",
      rapidApiKeyId,
      stats:
        initial as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Dual dispatch — fire both the targeted execute AND the runner in
  // parallel. Vercel's keepalive fire-and-forget occasionally drops
  // (observed ~4-5 min stalls until the 5-min cron noticed). With
  // two independent dispatches, at least one usually lands within
  // seconds. The runner picks up only jobs not being actively
  // hearted (see pickJobForRunner) so it won't run a second tranche
  // against the same job if the execute dispatch already started.
  const origin = new URL(req.url).origin;
  const auth = { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };
  const executeUrl = `${origin}/api/cron/pool-scrape-execute?jobId=${job.id}`;
  const runnerUrl = `${origin}/api/cron/pool-scrape-runner?fromDispatcher=1`;
  void fetch(executeUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[scrape] execute dispatch failed for job#${job.id}:`,
        (e as Error).message
      );
    }
  );
  void fetch(runnerUrl, { method: "POST", headers: auth, keepalive: true }).catch(
    (e) => {
      console.error(
        `[scrape] runner backup dispatch failed for job#${job.id}:`,
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
