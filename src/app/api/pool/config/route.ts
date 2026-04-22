import { NextResponse } from "next/server";
import { z } from "zod";
import { getPoolConfig, updatePoolConfig } from "@/lib/pool/config";

export async function GET() {
  const cfg = await getPoolConfig();
  return NextResponse.json({ config: cfg });
}

const patchSchema = z
  .object({
    autoRefillEnabled: z.boolean().optional(),
    refillThresholdInstagram: z.number().int().min(0).optional(),
    refillTargetInstagram: z.number().int().min(0).optional(),
    refillThresholdTiktok: z.number().int().min(0).optional(),
    refillTargetTiktok: z.number().int().min(0).optional(),
    maxRapidapiCallsPerScrapeRun: z.number().int().min(1).optional(),
    maxRapidapiCallsPerHealthcheck: z.number().int().min(1).optional(),
    maxAttemptsMethodB: z.number().int().min(1).optional(),
    maxPagesPerSeed: z.number().int().min(1).optional(),
    methodARatio: z.number().min(0).max(1).optional(),
    methodBEnabled: z.boolean().optional(),
    healthCheckEnabled: z.boolean().optional(),
    healthCheckCron: z.string().min(1).max(64).optional(),
    maxFollowerCount: z.number().int().min(0).optional(),
    maxFollowerCountTiktok: z.number().int().min(0).optional(),
    maxMediaCount: z.number().int().min(0).optional(),
    maxFollowingCount: z.number().int().min(0).optional(),
    requireNotPrivate: z.boolean().optional(),
    invalidateIfMediaAbove: z.number().int().min(0).optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const updated = await updatePoolConfig(parsed.data);
    return NextResponse.json({ ok: true, config: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
