import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { initHealthStats } from "@/lib/pool/health-check";
import { getSystemToggles } from "@/lib/system/toggles";

const bodySchema = z.object({
  platform: z.enum(["instagram", "tiktok", "both"]).default("both"),
});

export async function POST(req: Request) {
  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json(
      { error: "pool_healthcheck_disabled", message: "Pool health-check is paused by the kill switch." },
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
  const { platform } = parsed.data;

  const stats = initHealthStats(platform);

  const job = await prisma.poolJob.create({
    data: {
      jobType: "health_check",
      platform: platform === "both" ? null : platform,
      trigger: "manual",
      status: "pending",
      stats: stats as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ ok: true, jobId: job.id });
}
