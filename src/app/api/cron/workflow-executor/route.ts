// Master workflow cron — fires every minute. For each workflow
// with triggerType='cron' whose cronExpression matches the current
// minute (UTC), kicks a new WorkflowRun.
//
// GATED by SystemToggle.workflowExecutorEnabled (default FALSE).
// Legacy crons keep running until a follow-up commit disables them;
// this endpoint is a parallel shadow system until the operator
// flips the kill switch on.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { runWorkflow } from "@/lib/workflows/executor";
import { cronMatches } from "@/lib/workflows/scheduler";

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
  const flows = await prisma.workflow.findMany({
    where: { isActive: true, triggerType: "cron" },
    select: { id: true, slug: true, cronExpression: true },
  });

  const dueNow = flows.filter(
    (w) => w.cronExpression && cronMatches(w.cronExpression, now)
  );

  const results: Array<{
    slug: string;
    runId: number;
    status: string;
    error?: string;
  }> = [];

  for (const w of dueNow) {
    try {
      const r = await runWorkflow(w.id, "cron");
      results.push({
        slug: w.slug,
        runId: r.runId,
        status: r.status,
        error: r.error,
      });
    } catch (e) {
      results.push({
        slug: w.slug,
        runId: -1,
        status: "failed",
        error: (e as Error).message.slice(0, 300),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    tick: now.toISOString(),
    scanned: flows.length,
    dueNow: dueNow.length,
    results,
  });
}

export const GET = POST;
