// Flip Workflow.isActive. The executor cron skips inactive rows
// entirely.

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const schema = z.object({ isActive: z.boolean() });

export async function PATCH(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const w = await prisma.workflow.update({
      where: { slug: params.slug },
      data: { isActive: parsed.data.isActive },
    });
    return NextResponse.json({ ok: true, workflow: w });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
