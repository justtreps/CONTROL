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
    // Compare-and-swap: only flip if still 'active'. Two operators
    // double-clicking ACK won't race — the second updateMany matches
    // 0 rows. Also skips a needless write if the detector already
    // auto-resolved between click and POST.
    const claim = await prisma.alert.updateMany({
      where: { id, status: "active" },
      data: {
        status: "acknowledged",
        acknowledgedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const cur = await prisma.alert.findUnique({ where: { id } });
      if (!cur) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "already_terminal", currentStatus: cur.status },
        { status: 409 }
      );
    }
    const a = await prisma.alert.findUnique({ where: { id } });
    return NextResponse.json({ ok: true, alert: a });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
