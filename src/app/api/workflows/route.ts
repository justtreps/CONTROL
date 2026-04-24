// List workflows + their aggregate "last run" / "next run" metadata.
// Session-authed through middleware (it's under /api/workflows which
// isn't in PUBLIC_PATHS).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const workflows = await prisma.workflow.findMany({
    orderBy: [{ category: "asc" }, { slug: "asc" }],
  });

  const rows = await Promise.all(
    workflows.map(async (w) => {
      const lastRun = await prisma.workflowRun.findFirst({
        where: { workflowId: w.id },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          trigger: true,
        },
      });
      return {
        id: w.id,
        slug: w.slug,
        displayName: w.displayName,
        description: w.description,
        category: w.category,
        triggerType: w.triggerType,
        cronExpression: w.cronExpression,
        eventType: w.eventType,
        isActive: w.isActive,
        lastRunAt: w.lastRunAt?.toISOString() ?? null,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              trigger: lastRun.trigger,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            }
          : null,
        nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0,
      };
    })
  );

  return NextResponse.json({ workflows: rows });
}
