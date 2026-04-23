// List + create RapidAPI keys. Session-authed via middleware.
//
// Token values are never returned from the list endpoint — operators
// should never re-read them from the UI, only add/disable/delete.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await prisma.rapidApiKey.findMany({
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      provider: true,
      label: true,
      status: true,
      quotaMonthly: true,
      quotaUsed: true,
      resetDayOfMonth: true,
      rateLimitPerMin: true,
      lastCappedAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ rows });
}

const createSchema = z.object({
  provider: z.enum(["instagram", "tiktok"]),
  label: z.string().min(1).max(80),
  token: z.string().min(10),
  quotaMonthly: z.number().int().positive().optional(),
  resetDayOfMonth: z.number().int().min(1).max(31).optional(),
  rateLimitPerMin: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const row = await prisma.rapidApiKey.create({
    data: {
      provider: parsed.data.provider,
      label: parsed.data.label,
      token: parsed.data.token,
      status: "active",
      quotaMonthly: parsed.data.quotaMonthly ?? null,
      resetDayOfMonth: parsed.data.resetDayOfMonth ?? null,
      rateLimitPerMin: parsed.data.rateLimitPerMin ?? null,
    },
    select: { id: true, label: true, provider: true, status: true },
  });
  return NextResponse.json({ ok: true, row });
}
