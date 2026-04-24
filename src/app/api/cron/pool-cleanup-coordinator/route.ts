// Every 2 min — advances the pool-cleanup state machine one step.
// No-op when no cleanup session is active. See
// lib/pool/cleanup-coordinator.ts for the full lifecycle.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { tickCleanupCoordinator } from "@/lib/pool/cleanup-coordinator";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await tickCleanupCoordinator();
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
