// Alert reconciliation engine.
//
// Every 2 min the master cron (/api/cron/alerts-detector) calls
// runAllDetectors(). It:
//   1. Runs each Detector in turn, collects DetectorResult[] — one
//      entry per matched condition. A detector may emit 0..N rows.
//   2. Loads all currently-active Alert rows, indexes by code.
//   3. For every result: create a new Alert if no active row exists
//      with that code; otherwise bump triggerCount + lastTriggeredAt
//      on the existing one and refresh its content (severity /
//      explanation may evolve as numbers drift).
//   4. Any active Alert whose code DIDN'T appear in this tick's
//      results gets status='auto_resolved' + resolvedAt=now. The
//      same code can re-fire later as a brand-new row.
//
// Detector failures are caught individually — one broken detector
// can't kill the whole reconciliation.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DETECTORS } from "./detectors";
import type { DetectorResult } from "./types";

export type EngineResult = {
  detectorsRan: number;
  detectorErrors: Array<{ detector: string; error: string }>;
  hits: number;
  created: number;
  updated: number;
  autoResolved: number;
};

export async function runAllDetectors(): Promise<EngineResult> {
  const result: EngineResult = {
    detectorsRan: 0,
    detectorErrors: [],
    hits: 0,
    created: 0,
    updated: 0,
    autoResolved: 0,
  };

  const hits: DetectorResult[] = [];
  for (const d of DETECTORS) {
    result.detectorsRan++;
    try {
      const r = await d();
      for (const row of r) hits.push(row);
    } catch (e) {
      result.detectorErrors.push({
        detector: d.name || "anonymous",
        error: (e as Error).message.slice(0, 300),
      });
    }
  }
  result.hits = hits.length;

  // De-duplicate hits by code — a buggy detector that returns the
  // same code twice shouldn't double-create.
  const byCode = new Map<string, DetectorResult>();
  for (const h of hits) {
    byCode.set(h.code, h);
  }

  const activeNow = await prisma.alert.findMany({
    where: { status: "active" },
    select: { id: true, code: true },
  });
  const existingByCode: Record<string, number> = {};
  for (const a of activeNow) existingByCode[a.code] = a.id;

  const entries: Array<[string, DetectorResult]> = Array.from(byCode).map(
    (kv) => [kv[0], kv[1]] as [string, DetectorResult]
  );
  for (const [code, hit] of entries) {
    const existingId = existingByCode[code];
    if (!existingId) {
      await prisma.alert.create({
        data: {
          code: hit.code,
          category: hit.category,
          severity: hit.severity,
          title: hit.title,
          description: hit.description,
          explanation: hit.explanation,
          impact: hit.impact,
          suggestedAction: hit.suggestedAction,
          actionType: hit.actionType ?? null,
          actionPayload:
            (hit.actionPayload as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          relatedEntityType: hit.relatedEntityType ?? null,
          relatedEntityId: hit.relatedEntityId ?? null,
        },
      });
      result.created++;
    } else {
      // Active alert re-fires every detector tick (every 2 min)
      // as long as the underlying condition stays true. Bumping
      // triggerCount on EVERY tick produced 1000+ counts within
      // a day for stable conditions like dry_run_off_with_testbot
      // — meaningless noise. We now only refresh content + bump
      // lastTriggeredAt; triggerCount stays at its initial 1
      // until the alert auto-resolves and re-fires fresh.
      await prisma.alert.update({
        where: { id: existingId },
        data: {
          lastTriggeredAt: new Date(),
          // Refresh content — severity + numbers may have moved.
          severity: hit.severity,
          title: hit.title,
          description: hit.description,
          explanation: hit.explanation,
          impact: hit.impact,
          suggestedAction: hit.suggestedAction,
          actionType: hit.actionType ?? null,
          actionPayload:
            (hit.actionPayload as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          relatedEntityType: hit.relatedEntityType ?? null,
          relatedEntityId: hit.relatedEntityId ?? null,
        },
      });
      result.updated++;
    }
  }

  // Auto-resolve every still-active alert whose code didn't fire this tick.
  // Use updateMany for a single round-trip.
  const stillActiveCodes: Record<string, boolean> = {};
  for (const code of Array.from(byCode.keys())) {
    stillActiveCodes[code] = true;
  }
  const toResolveIds = activeNow
    .filter((a) => !stillActiveCodes[a.code])
    .map((a) => a.id);
  if (toResolveIds.length > 0) {
    const r = await prisma.alert.updateMany({
      where: { id: { in: toResolveIds } },
      data: { status: "auto_resolved", resolvedAt: new Date() },
    });
    result.autoResolved = r.count;
  }

  return result;
}

