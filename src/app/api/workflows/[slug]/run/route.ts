// Manual trigger — fires a workflow run from the "[ LANCER MAINTENANT ]"
// button. Returns quickly; the executor is synchronous so this
// blocks until the chain finishes (WAIT nodes are currently no-ops
// so even long-looking flows land in seconds).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runWorkflow } from "@/lib/workflows/executor";

export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const w = await prisma.workflow.findUnique({
    where: { slug: params.slug },
    select: { id: true },
  });
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const result = await runWorkflow(w.id, "manual");
  return NextResponse.json({ ok: true, ...result });
}
