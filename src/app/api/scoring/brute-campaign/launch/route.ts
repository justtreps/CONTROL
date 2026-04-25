// Operator trigger to fire the brute-force campaign #2.
// Snapshots NEW eligible services, creates a ScoringCampaign
// row with stopReason='brute_mode', and immediately fires the
// first tick fire-and-forget so placement starts within seconds.
// Subsequent ticks come from the every-minute brute-campaign-
// runner cron until placedCount >= targetCount.

import { NextResponse } from "next/server";
import { z } from "zod";
import { launchBruteCampaign } from "@/lib/scoring/brute-campaign";

// Middleware enforces session auth on /api/scoring/*. Logged-in
// operator only.

export const maxDuration = 30;

const bodySchema = z.object({
  maxCostPerTestUsd: z.number().positive().optional(),
});

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const r = await launchBruteCampaign(parsed.data);
  if ("error" in r) {
    return NextResponse.json(r, { status: 400 });
  }

  // Fire-and-forget the first tick so placements start before
  // the next cron firing (≤ 60 s wait otherwise).
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const secret = process.env.CRON_SECRET ?? "";
  void fetch(`${origin}/api/cron/brute-campaign-runner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  }).catch(() => null);

  return NextResponse.json({ ok: true, ...r });
}

export const GET = POST;
