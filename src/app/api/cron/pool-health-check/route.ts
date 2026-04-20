// Cron-scheduled health check. Queues a health_check job for both
// platforms; the orchestrator picks it up and runs tranches until
// done. Honors PoolConfig.healthCheckEnabled.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "@/lib/pool/config";
import { initHealthStats } from "@/lib/pool/health-check";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cfg = await getPoolConfig();
  if (!cfg.healthCheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  // Idempotent: if a health_check is already pending/running, skip.
  const active = await prisma.poolJob.findFirst({
    where: {
      jobType: "health_check",
      status: { in: ["pending", "running"] },
    },
  });
  if (active) {
    return NextResponse.json({ ok: true, skipped: "already_running", jobId: active.id });
  }

  const stats = initHealthStats("both");
  const job = await prisma.poolJob.create({
    data: {
      jobType: "health_check",
      platform: null,
      trigger: "cron",
      status: "pending",
      stats: stats as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ ok: true, jobId: job.id });
}

export const GET = POST;
