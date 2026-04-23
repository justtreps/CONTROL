// PATCH + DELETE a RapidAPI key. Session-authed via middleware.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const patchSchema = z
  .object({
    status: z.enum(["active", "capped", "disabled"]).optional(),
    label: z.string().min(1).max(80).optional(),
    quotaMonthly: z.number().int().positive().nullable().optional(),
    resetDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    rateLimitPerMin: z.number().int().positive().nullable().optional(),
    // Explicit reset action for forced "I know what I'm doing".
    resetQuotaUsed: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.label !== undefined) data.label = parsed.data.label;
  if (parsed.data.quotaMonthly !== undefined)
    data.quotaMonthly = parsed.data.quotaMonthly;
  if (parsed.data.resetDayOfMonth !== undefined)
    data.resetDayOfMonth = parsed.data.resetDayOfMonth;
  if (parsed.data.rateLimitPerMin !== undefined)
    data.rateLimitPerMin = parsed.data.rateLimitPerMin;
  if (parsed.data.resetQuotaUsed) data.quotaUsed = 0;

  const row = await prisma.rapidApiKey
    .update({
      where: { id },
      data,
      select: {
        id: true,
        label: true,
        provider: true,
        status: true,
        quotaMonthly: true,
        quotaUsed: true,
      },
    })
    .catch(() => null);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, row });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  await prisma.rapidApiKey.delete({ where: { id } }).catch(() => null);
  // Any PoolJob currently pointing at this key will have its
  // rapidApiKeyId dangle — the withAssignedKey() helper falls
  // through to acquireKeyForNewJob() when the lookup returns null,
  // so running jobs recover silently.
  return NextResponse.json({ ok: true });
}
