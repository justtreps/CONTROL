// Manual (session-authed) sync trigger. Bypasses the cron's
// servicesSyncFrequencyHours gate so the operator can force a refresh
// from /pool Zone 4 C without waiting for the next eligible tick.
// Stamps PoolConfig.lastServicesSyncAt + lastServicesSyncResult the
// same way the cron does so the UI readout stays coherent.

import { NextResponse } from "next/server";
import { syncServices } from "@/lib/bulkmedya";
import { prisma } from "@/lib/prisma";

// Catalog sync can take > 60s after the MVP scope opening (~9.6k
// candidates processed serially). Match the cron's ceiling.
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await syncServices();
    await prisma.poolConfig.update({
      where: { id: 1 },
      data: {
        lastServicesSyncAt: new Date(),
        lastServicesSyncResult:
          result as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
