// Seed the 8 canonical workflows. Idempotent — existing rows get
// their metadata refreshed but their nodes JSON is preserved so
// operator edits don't get clobbered on re-seed.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { seedWorkflows } from "@/lib/workflows/seeds";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await seedWorkflows();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;
