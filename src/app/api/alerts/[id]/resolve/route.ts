// Manual resolve — operator declares the alert fixed even if the
// detector hasn't auto-resolved it yet. Next detector tick may re-
// create a new Alert row with the same code if the condition is
// still live, but this current row goes into the audit trail.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const a = await prisma.alert.update({
      where: { id },
      data: { status: "resolved", resolvedAt: new Date() },
    });
    return NextResponse.json({ ok: true, alert: a });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
