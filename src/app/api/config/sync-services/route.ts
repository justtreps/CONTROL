// Manual (session-authed) sync trigger. Fire-and-forget wrapper that
// dispatches to /api/cron/sync-services-execute so the click returns
// in <500ms — a full sync takes 60-300s which would otherwise hang
// the button + browser tab (same pattern we fixed for scrape +
// health-check buttons).
//
// Bypasses the frequency gate: manual clicks always try to acquire
// the servicesSyncStartedAt lock and dispatch. If another run is
// in-flight (<10 min old), return { skipped: "already_running" } so
// the UI can tell the user instead of silently stomping.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "@/lib/pool/config";

export const maxDuration = 10;

const STALE_LOCK_MS = 10 * 60 * 1000; // 10 min — generous worker budget

export async function POST(req: Request) {
  const cfg = await getPoolConfig();

  // Lock acquisition — if another manual click OR the cron started a
  // run recently and it's still alive, bail cleanly.
  if (cfg.servicesSyncStartedAt) {
    const elapsedMs = Date.now() - cfg.servicesSyncStartedAt.getTime();
    if (elapsedMs < STALE_LOCK_MS) {
      return NextResponse.json({
        ok: true,
        skipped: "already_running",
        startedAt: cfg.servicesSyncStartedAt.toISOString(),
        ageMs: elapsedMs,
      });
    }
    // Stale lock (>10 min) — probably a dead worker. Fall through and
    // overwrite below.
  }

  await prisma.poolConfig.update({
    where: { id: 1 },
    data: { servicesSyncStartedAt: new Date() },
  });

  // Fire-and-forget. Keepalive keeps the outbound TCP alive past this
  // function's death; the runner cron is the safety net if the
  // dispatch misfires (same pattern the pool runners use).
  const origin = new URL(req.url).origin;
  const executeUrl = `${origin}/api/cron/sync-services-execute`;
  void fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    keepalive: true,
  }).catch((e) => {
    console.error(
      `[sync-services] failed to dispatch execute: ${(e as Error).message}`
    );
  });

  return NextResponse.json({ ok: true, status: "started" });
}
