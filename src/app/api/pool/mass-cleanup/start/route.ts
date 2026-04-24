// Operator-triggered start of the mass pool cleanup flow. Called
// from the dashboard "NETTOYER POOL" button or from the
// pool_insufficient alert action. Idempotent — multiple calls just
// confirm the session is active.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { beginCleanup, readSession } from "@/lib/pool/cleanup-coordinator";

// Middleware enforces session auth on /api/pool/*. No explicit check
// needed here — the request is either from a logged-in operator or
// it's already been rejected upstream.

export const maxDuration = 30;

const bodySchema = z.object({
  campaignId: z.number().int().positive().optional(),
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

  // Resolve the target campaign — either explicit or the only
  // running/paused one.
  const campaignId =
    parsed.data.campaignId ??
    (
      await prisma.scoringCampaign.findFirst({
        where: { status: { in: ["running", "paused"] } },
        orderBy: { id: "desc" },
      })
    )?.id;

  if (!campaignId) {
    return NextResponse.json(
      { error: "no_active_campaign" },
      { status: 404 }
    );
  }

  const existing = await readSession();
  if (existing) {
    return NextResponse.json({
      ok: true,
      alreadyRunning: true,
      session: existing,
    });
  }

  const session = await beginCleanup(campaignId);
  return NextResponse.json({ ok: true, session });
}

export const GET = POST;
