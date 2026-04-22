// One-shot country-detection backfill for TestAccount rows created
// before the countryDetection feature landed. Works on existing
// sparse data: we have username + sometimes we have nothing else
// (full_name/biography weren't stored pre-feature), so the
// detector only hits tiers 3-4 (username affix / cultural first
// name). Better than nothing — operators can re-oracle individual
// rows later if they want finer results.
//
// Idempotent: rows with countryConfidence != 'unknown' are skipped.
// Auth: Bearer CRON_SECRET.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { detectAccountCountry } from "@/lib/pool/country-detection";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Work only on rows the detector hasn't seen yet. Saves cycles on
  // repeated runs.
  const rows = await prisma.testAccount.findMany({
    where: { countryConfidence: "unknown" },
    select: { id: true, platform: true, username: true },
  });

  const countryCounts: Record<string, number> = {};
  const confidenceCounts: Record<string, number> = {
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  let updated = 0;

  // Keep batches small so a 60s serverless budget is plenty even on
  // large pools. The detector itself is synchronous and CPU-bound.
  for (const r of rows) {
    const det = detectAccountCountry({ username: r.username });
    confidenceCounts[det.confidence] =
      (confidenceCounts[det.confidence] ?? 0) + 1;
    if (det.country) {
      countryCounts[det.country] = (countryCounts[det.country] ?? 0) + 1;
    }
    if (det.confidence !== "unknown") {
      await prisma.testAccount.update({
        where: { id: r.id },
        data: {
          detectedCountry: det.country,
          countryConfidence: det.confidence,
        },
      });
      updated++;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    updated,
    byConfidence: confidenceCounts,
    byCountry: countryCounts,
  });
}

export const GET = POST;
