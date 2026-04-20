// Weekly cleanup: archive consumed/invalid TestAccount rows older than
// 90 days. Pushes a cleanup job so it shows up in the job history.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const active = await prisma.poolJob.findFirst({
    where: { jobType: "cleanup", status: { in: ["pending", "running"] } },
  });
  if (active) {
    return NextResponse.json({ ok: true, skipped: "already_running", jobId: active.id });
  }

  const job = await prisma.poolJob.create({
    data: {
      jobType: "cleanup",
      platform: null,
      trigger: "cron",
      status: "pending",
    },
  });
  return NextResponse.json({ ok: true, jobId: job.id });
}

export const GET = POST;
