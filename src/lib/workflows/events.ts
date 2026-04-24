// Event bus for workflow triggers.
//
// emit(type, payload) enqueues a WorkflowEvent row. The master cron
// at /api/cron/workflow-executor picks unprocessed rows every minute
// and fires any workflow whose triggerType='event' + eventType
// matches. Multiple workflows can listen to the same type.
//
// Emitters live inside existing code paths:
//   • pool health-check → emits pool.below_threshold.{follower|engagement}
//     when the post-check count dips under the threshold.
//   • syncServices end   → emits services.synced
//   • testbot attemptPlaceOrder → emits service.died when a BulkMedya
//     placement returns a terminal provider error.
//
// Keep emit() best-effort: a logging failure must not break the
// caller's flow. Swallow + console.warn.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type EventType =
  | "pool.below_threshold.follower"
  | "pool.below_threshold.engagement"
  | "services.synced"
  | "service.died"
  | string; // allow arbitrary strings so custom workflows can define new events

export async function emit(
  type: EventType,
  payload: Record<string, unknown> = {}
): Promise<number | null> {
  try {
    const row = await prisma.workflowEvent.create({
      data: {
        type,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.warn(
      `[workflows.emit] failed to enqueue event ${type}:`,
      (e as Error).message
    );
    return null;
  }
}

// Process a batch of unprocessed events. For each one:
//   1. Find all active workflows with matching eventType
//   2. Create a WorkflowRun per match via runWorkflow
//   3. Stamp processedAt + runsTriggered on the event row
//
// Returns a summary the master cron surfaces in its JSON response.
export type ProcessResult = {
  eventsProcessed: number;
  runsFired: number;
  details: Array<{ eventId: number; type: string; workflowSlugs: string[] }>;
};

export async function processPendingEvents(): Promise<ProcessResult> {
  // Lazy import — avoids a circular import with executor.ts, which
  // itself imports this module for typings.
  const { runWorkflow } = await import("./executor");

  const events = await prisma.workflowEvent.findMany({
    where: { processedAt: null },
    orderBy: { emittedAt: "asc" },
    take: 50,
  });

  const result: ProcessResult = {
    eventsProcessed: 0,
    runsFired: 0,
    details: [],
  };

  for (const ev of events) {
    const listeners = await prisma.workflow.findMany({
      where: {
        isActive: true,
        triggerType: "event",
        eventType: ev.type,
      },
      select: { id: true, slug: true },
    });

    const slugs: string[] = [];
    for (const l of listeners) {
      try {
        // Seed context with the event payload so nodes can read it
        // via ctx.event.
        await runWorkflow(l.id, "event", {
          sourceEventId: ev.id,
          initialContext: {
            event: { type: ev.type, payload: ev.payload },
          },
        });
        slugs.push(l.slug);
        result.runsFired++;
      } catch (e) {
        console.warn(
          `[workflows.events] workflow=${l.slug} failed on event=${ev.id}:`,
          (e as Error).message
        );
      }
    }

    await prisma.workflowEvent.update({
      where: { id: ev.id },
      data: { processedAt: new Date(), runsTriggered: slugs.length },
    });
    result.eventsProcessed++;
    result.details.push({
      eventId: ev.id,
      type: ev.type,
      workflowSlugs: slugs,
    });
  }

  return result;
}
