// One-shot — re-runs the matcher over every Service × Product pair
// and upserts ProductServiceCandidate rows. Operator-triggered from
// the [REMATCHER TOUS LES SERVICES] button; automatically fired at
// the end of every syncServices run.
//
// Auth: cron-authed (Bearer CRON_SECRET) so it's reachable via curl
// + from the session-authed UI (fetch from client forwards cookies).
// Kept out of PUBLIC_PATHS so a random attacker can't fire it — the
// UI goes through a session-authed wrapper in a follow-up if that
// becomes a real problem.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { rematchAll } from "@/lib/catalogue/matcher";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await rematchAll();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;
