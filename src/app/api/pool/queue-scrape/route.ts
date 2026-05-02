// CRON_SECRET-gated mirror of /api/pool/scrape — same shape, but
// authenticated via Authorization: Bearer CRON_SECRET so it can be
// curled from a script (no session cookie required).
//
// Body: { platform, count, poolType } (same as /api/pool/scrape)
//
// Why this exists: /api/pool/scrape is session-gated for the
// dashboard button. Operations automation (post-deploy curl,
// alert-bound action, batch refill) needs the same enqueue
// behaviour without a browser session. We mirror the logic 1:1
// rather than weaken the session check on the original endpoint.
//
// Idempotent: if an in-flight scrape with the same poolType
// universe already exists, return the existing jobId instead of
// stacking a duplicate.

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { initScrapeStats } from "@/lib/pool/scraper";
import { acquireKeyForNewJob } from "@/lib/rapidapi/key-manager";
import { dispatchWorkerPair } from "@/lib/pool/dispatch";

export const maxDuration = 10;

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
  count: z.number().int().positive().max(10000).default(1000),
  poolType: z.enum(["follower", "engagement"]).optional(),
});

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { platform, count, poolType } = parsed.data;

  // Same idempotency guard as /api/pool/scrape: one scrape in
  // flight per pool universe (follower / engagement). Different
  // universes may run in parallel.
  const activeList = await prisma.poolJob.findMany({
    where: { jobType: "scrape", status: { in: ["pending", "running"] } },
  });
  const active = activeList.find((j) => {
    const jobPool = (j.stats as unknown as { poolType?: string } | null)
      ?.poolType;
    if (poolType) return jobPool === poolType;
    return true;
  });
  if (active) {
    return NextResponse.json({
      ok: true,
      skipped: "already_running",
      jobId: active.id,
      status: active.status,
    });
  }

  const initial = initScrapeStats(platform, count);
  if (poolType) {
    (initial as unknown as { poolType?: string }).poolType = poolType;
  }

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

  // Dispatch the worker pair so the job actually runs (mirrors
  // /api/pool/scrape's behaviour). pool-scrape-runner cron will
  // pick it up as a backstop if dispatch fails.
  const origin = new URL(req.url).origin;
  await dispatchWorkerPair({
    executeUrl: `${origin}/api/cron/pool-scrape-execute?jobId=${job.id}`,
    runnerUrl: `${origin}/api/cron/pool-scrape-runner?fromDispatcher=1`,
    cronSecret: process.env.CRON_SECRET,
    jobLabel: `scrape job#${job.id}`,
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: "running",
    platform,
    count,
    poolType,
  });
}

export const GET = POST;
