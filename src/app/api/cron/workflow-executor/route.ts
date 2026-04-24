// Master workflow cron — fires every minute. Per tick it does 3 things:
//   1. processPendingEvents — drains WorkflowEvent rows, fires event
//      workflows that subscribe to the type.
//   2. cronMatches scan — every active cron workflow whose 5-field
//      expression matches the current UTC minute gets a fresh run.
//   3. resumePausedRun for each WorkflowRun in status='paused' whose
//      resumeAt has elapsed (WAIT nodes).
//
// GATED by SystemToggle.workflowExecutorEnabled. Legacy crons keep
// running until a follow-up migration commit disables them.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { runWorkflow, resumePausedRun } from "@/lib/workflows/executor";
import { cronMatches } from "@/lib/workflows/scheduler";
import { processPendingEvents } from "@/lib/workflows/events";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.workflowExecutorEnabled) {
    return NextResponse.json({
      ok: true,
      skipped: "workflow_executor_disabled",
    });
  }

  const now = new Date();

  // 1. Drain pending events → fires event workflows.
  const eventResult = await processPendingEvents().catch((e) => {
    console.warn("[workflow-executor] events failed:", (e as Error).message);
    return { eventsProcessed: 0, runsFired: 0, details: [] };
  });

  // 2. Fire cron-due workflows.
  const flows = await prisma.workflow.findMany({
    where: { isActive: true, triggerType: "cron" },
    select: { id: true, slug: true, cronExpression: true },
  });
  const cronDue = flows.filter(
    (w) => w.cronExpression && cronMatches(w.cronExpression, now)
  );
  const cronResults: Array<{
    slug: string;
    runId: number;
    status: string;
    error?: string;
  }> = [];
  for (const w of cronDue) {
    try {
      const r = await runWorkflow(w.id, "cron");
      cronResults.push({
        slug: w.slug,
        runId: r.runId,
        status: r.status,
        error: r.error,
      });
    } catch (e) {
      cronResults.push({
        slug: w.slug,
        runId: -1,
        status: "failed",
        error: (e as Error).message.slice(0, 300),
      });
    }
  }

  // 3. Resume paused runs whose resumeAt has elapsed.
  const pausedDue = await prisma.workflowRun.findMany({
    where: { status: "paused", resumeAt: { lte: now } },
    select: { id: true, workflowId: true },
    take: 30,
  });
  const resumeResults: Array<{
    runId: number;
    status: string;
    error?: string;
  }> = [];
  for (const r of pausedDue) {
    try {
      const res = await resumePausedRun(r.id);
      resumeResults.push({
        runId: res.runId,
        status: res.status,
        error: res.error,
      });
    } catch (e) {
      resumeResults.push({
        runId: r.id,
        status: "failed",
        error: (e as Error).message.slice(0, 300),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    tick: now.toISOString(),
    cron: { scanned: flows.length, dueNow: cronDue.length, results: cronResults },
    events: eventResult,
    resumed: resumeResults,
  });
}

export const GET = POST;
