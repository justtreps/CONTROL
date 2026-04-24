// Mark an alert as acknowledged (seen by the operator). Alert stays
// visible in the list but drops out of the "active" count — the
// banner stops flashing once every critical is acknowledged or
// resolved. Detector may re-trigger it later: if the condition is
// still true on the next tick, we update the existing row (keeping
// acknowledged status) and bump triggerCount.

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
      data: {
        status: "acknowledged",
        acknowledgedAt: new Date(),
        // acknowledgedBy left null in v1 — we don't have per-user auth.
      },
    });
    return NextResponse.json({ ok: true, alert: a });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
