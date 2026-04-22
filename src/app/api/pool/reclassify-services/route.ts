// One-shot (idempotent) — runs the classifier over every Service
// row and writes back poolType + targetCountry + classification
// ManualReview. Callable repeatedly (e.g. after adding new
// classifier patterns) without corrupting existing manual reviews:
// we ALWAYS overwrite the classifier's output, so if a manual
// reviewer had intervened their edit is reset. Matches the spec
// ("Reclassifier services" button).
//
// Auth: Bearer CRON_SECRET so the operator can curl it; also
// reachable from the /config UI as a triggered endpoint.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { classifyService } from "@/lib/services/classifier";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const services = await prisma.service.findMany({
    select: { id: true, name: true },
  });

  const counts: Record<string, number> = {
    follower_test: 0,
    engagement_test: 0,
    unknown: 0,
    manual_review: 0,
  };
  const countryCounts: Record<string, number> = {};

  for (const s of services) {
    const { poolType, targetCountry, classificationManualReview } =
      classifyService(s.name);
    counts[poolType] = (counts[poolType] ?? 0) + 1;
    if (classificationManualReview) counts.manual_review++;
    const countryKey = targetCountry ?? "global";
    countryCounts[countryKey] = (countryCounts[countryKey] ?? 0) + 1;

    await prisma.service.update({
      where: { id: s.id },
      data: { poolType, targetCountry, classificationManualReview },
    });
  }

  return NextResponse.json({
    ok: true,
    total: services.length,
    byPoolType: counts,
    byCountry: countryCounts,
  });
}

export const GET = POST;
