// One-shot (idempotent) — runs the strict-whitelist classifier over
// every Service row and writes back poolType + targetCountry +
// classificationManualReview + active. Callable repeatedly, e.g.
// after a classifier refactor: we ALWAYS overwrite the classifier's
// output, so operator manual overrides are reset. Match the spec
// ("Reclassifier services" button).
//
// Auth: Bearer CRON_SECRET so the operator can curl it; also
// reachable from the /config UI as a triggered endpoint.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { classifyService } from "@/lib/services/classifier";

// ~5k Service rows — per-row update loop crosses 60s under the
// pooler. Keep at 300s so the one-shot always completes in one call.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const services = await prisma.service.findMany({
    select: { id: true, name: true, platform: true },
  });

  const byVerdict: Record<string, number> = {
    follower: 0,
    engagement: 0,
    manual: 0,
    disabled: 0,
  };
  const countryCounts: Record<string, number> = {};

  for (const s of services) {
    const {
      verdict,
      poolType,
      targetCountry,
      active,
      classificationManualReview,
    } = classifyService({ name: s.name, platform: s.platform });

    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    const countryKey = targetCountry ?? "global";
    countryCounts[countryKey] = (countryCounts[countryKey] ?? 0) + 1;

    await prisma.service.update({
      where: { id: s.id },
      data: {
        poolType,
        targetCountry,
        classificationManualReview,
        active,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    total: services.length,
    byVerdict,
    byCountry: countryCounts,
  });
}

export const GET = POST;
