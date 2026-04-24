// Recent runs for a workflow — powers the history drawer. Returns
// timeline-ready rows (startedAt, finishedAt, status, node count,
// trigger). Full logs live on the WorkflowRun row and are read on
// demand from the per-run endpoint (not yet built; the drawer
// shows only summary for v1).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const w = await prisma.workflow.findUnique({
    where: { slug: params.slug },
    select: { id: true },
  });
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: w.id },
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      currentNodeId: r.currentNodeId,
      logs: Array.isArray(r.logs) ? r.logs : [],
    })),
  });
}
