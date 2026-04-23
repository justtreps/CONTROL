import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { syncServices } from "@/lib/bulkmedya";
import { getPoolConfig } from "@/lib/pool/config";
import { prisma } from "@/lib/prisma";

// Scope-opening (engagement types) means BulkMedya returns ~4-5k
// candidate rows instead of ~1900; we need headroom beyond the
// default 60s Vercel Hobby cap.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Frequency gate — Vercel crons can only be scheduled statically so
  // the schedule is a hard "every hour" ceiling. The actual run
  // cadence is driven by servicesSyncFrequencyHours on PoolConfig
  // (operator-editable from /pool Zone 4 C). If we ran too recently,
  // skip cleanly so the slot doesn't bill a RapidAPI call for nothing.
  const cfg = await getPoolConfig();
  const freqHours = Math.max(1, cfg.servicesSyncFrequencyHours ?? 1);
  const last = cfg.lastServicesSyncAt;
  if (last) {
    const elapsedMs = Date.now() - last.getTime();
    if (elapsedMs < freqHours * 3600_000) {
      const remainingMin = Math.ceil(
        (freqHours * 3600_000 - elapsedMs) / 60_000
      );
      return NextResponse.json({
        ok: true,
        skipped: "frequency_gate",
        lastRunAt: last.toISOString(),
        freqHours,
        nextEligibleInMin: remainingMin,
      });
    }
  }

  // Second gate — a manual click may have started a sync seconds
  // before us. Respect that lock so we don't run twice in parallel
  // and double-bill BulkMedya.
  const STALE_LOCK_MS = 10 * 60 * 1000;
  if (cfg.servicesSyncStartedAt) {
    const elapsedMs = Date.now() - cfg.servicesSyncStartedAt.getTime();
    if (elapsedMs < STALE_LOCK_MS) {
      return NextResponse.json({
        ok: true,
        skipped: "already_running",
        startedAt: cfg.servicesSyncStartedAt.toISOString(),
      });
    }
  }

  // Acquire the lock inline — the cron keeps its inline-run style
  // (it's already running in a 300s cron slot, no need for the fire-
  // and-forget dispatch dance that the UI needs).
  await prisma.poolConfig.update({
    where: { id: 1 },
    data: { servicesSyncStartedAt: new Date() },
  });

  try {
    const result = await syncServices();
    // Stamp the run timestamp + counts so the UI can show "last sync
    // Xh ago, +N services" and the gate above works on the next tick.
    await prisma.poolConfig.update({
      where: { id: 1 },
      data: {
        lastServicesSyncAt: new Date(),
        lastServicesSyncResult:
          result as unknown as import("@prisma/client").Prisma.InputJsonValue,
        servicesSyncStartedAt: null,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
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
