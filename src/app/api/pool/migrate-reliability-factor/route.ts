// One-shot — adds the new reliability-factor columns to the Service
// table via raw SQL. Idempotent ("ADD COLUMN IF NOT EXISTS"), so
// re-running it is a safe no-op once the schema is in sync.
//
// Why it exists: the project ships schema changes via
// `npx prisma db push` from a developer machine — Vercel's build
// only runs `prisma generate`, not push. After landing the
// reliability-factor refactor, the deployed code references columns
// (perfectCount, partialCount, failCount, reliabilityFactor) that
// only exist in the local schema until somebody pushes. This
// endpoint lets the operator apply that push from any shell with
// the CRON_SECRET — no need for a privileged tool, no risk of
// missing the deployment window.
//
// The DDL uses ADD COLUMN IF NOT EXISTS (Postgres ≥ 9.6) so the
// endpoint can be curled freely; once the columns exist subsequent
// calls are no-ops at the SQL level.
//
// Auth: Bearer CRON_SECRET. Whitelisted in middleware.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  // Each statement is its own $executeRawUnsafe so a single failure
  // surfaces with a precise column name in the error. The columns
  // are nullable / defaulted so existing rows are valid out of the
  // box.
  const stmts = [
    `ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "perfectCount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "partialCount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "failCount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "reliabilityFactor" DOUBLE PRECISION`,
  ];
  const applied: string[] = [];
  const errors: Array<{ stmt: string; error: string }> = [];
  for (const s of stmts) {
    try {
      await prisma.$executeRawUnsafe(s);
      applied.push(s);
    } catch (e) {
      errors.push({ stmt: s, error: (e as Error).message.slice(0, 200) });
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    elapsedMs: Date.now() - t0,
    applied: applied.length,
    errors,
    note: "Idempotent — re-run safe. Next: curl /api/scoring/recompute-reliability to backfill counts + factor, then /api/cron/scoring to apply the multiplier in ServiceScore.",
  });
}

export const GET = POST;
