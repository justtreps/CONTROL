import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { syncServices } from "@/lib/bulkmedya";
import { getPoolConfig } from "@/lib/pool/config";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";

// Scope-opening (engagement types) means BulkMedya returns ~4-5k
// candidate rows instead of ~1900; we need headroom beyond the
// default 60s Vercel Hobby cap.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Kill switch for the daily sync. Separate from servicesSyncFrequencyHours
  // (which caps cadence) so an operator can halt all syncs without
  // editing PoolConfig.
  const toggles = await getSystemToggles();
  if (!toggles.dailySyncEnabled) {
    return NextResponse.json({ ok: true, skipped: "daily_sync_disabled" });
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
    // Emit a catalogue_new_services alert when the sync picked up
    // ≥1 new row. Upsert rather than create — detector's
    // auto-resolve will clear it on the next tick once the operator
    // has seen it.
    if (result.created > 0) {
      try {
        const existing = await prisma.alert.findFirst({
          where: {
            code: "catalogue_new_services",
            status: { in: ["active", "acknowledged"] },
          },
        });
        const title = `${result.created} nouveaux services ajoutés au catalogue`;
        const description = `Sync BulkMedya du ${new Date().toISOString().slice(0, 16)} → ${result.created} services inédits, ${result.updated} mis à jour, ${result.deactivated} désactivés.`;
        if (existing) {
          await prisma.alert.update({
            where: { id: existing.id },
            data: {
              title,
              description,
              lastTriggeredAt: new Date(),
              triggerCount: { increment: 1 },
              status: "active",
            },
          });
        } else {
          await prisma.alert.create({
            data: {
              code: "catalogue_new_services",
              category: "catalogue",
              severity: "info",
              title,
              description,
              explanation: `Les nouveaux services passent par le matcher et se retrouvent dans l'état lifecycleStatus=NEW. Ils seront testés à la prochaine campagne scoring ou via le daily-retest cron une fois qualifiés.`,
              impact: "Aucun — les nouveaux services n'impactent pas le routage tant qu'ils ne sont pas QUALIFIED.",
              suggestedAction: "Aller sur /config/catalogue pour voir les nouveaux services par produit.",
              actionType: "link",
              actionPayload: { href: "/config/catalogue" },
              status: "active",
              firstTriggeredAt: new Date(),
              lastTriggeredAt: new Date(),
              triggerCount: 1,
            },
          });
        }
      } catch {
        // Best-effort — sync itself already landed.
      }
    }
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
