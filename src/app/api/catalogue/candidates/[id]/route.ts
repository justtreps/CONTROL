// Operator override: toggle forceExcluded on a ProductServiceCandidate.
// The matcher can still flip isEligible up/down on each rematch run,
// but forceExcluded wins for routing + testbot picks.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  forceExcluded: z.boolean().optional(),
});

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
    const updated = await prisma.productServiceCandidate.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json({ ok: true, candidate: updated });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
