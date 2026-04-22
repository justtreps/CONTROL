// Patch a single Service's classification fields. Used by the
// /config/services-review page to override the auto-classifier
// decision.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const patchSchema = z
  .object({
    poolType: z.enum(["follower_test", "engagement_test", "unknown"]).optional(),
    targetCountry: z.string().length(2).nullable().optional(),
    classificationManualReview: z.boolean().optional(),
    active: z.boolean().optional(),
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
  try {
    const updated = await prisma.service.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json({ ok: true, service: updated });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
