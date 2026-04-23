// Worker for a BulkMedya services sync. Shared backend for:
//   • /api/config/sync-services     — manual fire-and-forget trigger
//   • /api/cron/sync-services       — the hourly scheduled cron
// Both dispatchers set PoolConfig.servicesSyncStartedAt = now (the
// lock) and forward here. This worker runs the sync, stamps
// lastServicesSync{At,Result}, and releases the lock — always, even
// on error, so a crash doesn't strand the lock and block future
// dispatches.
//
// Auth: Bearer CRON_SECRET. Called either by an external Vercel cron
// or by an internal keepalive fetch from /api/config/sync-services.
// Direct-run 300s budget matches the sync's actual cost post-MVP-scope.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { syncServices } from "@/lib/bulkmedya";
import { prisma } from "@/lib/prisma";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncServices();
    await prisma.poolConfig.update({
      where: { id: 1 },
      data: {
        lastServicesSyncAt: new Date(),
        lastServicesSyncResult:
          result as unknown as import("@prisma/client").Prisma.InputJsonValue,
        servicesSyncStartedAt: null, // release lock
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Always release the lock so a failure doesn't strand future runs.
    await prisma.poolConfig
      .update({
        where: { id: 1 },
        data: { servicesSyncStartedAt: null },
      })
      .catch(() => null);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
