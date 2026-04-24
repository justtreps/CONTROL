// Manual trigger — fires a workflow run from the "[ LANCER MAINTENANT ]"
// button. Returns quickly; the executor is synchronous so this
// blocks until the chain finishes (WAIT nodes are currently no-ops
// so even long-looking flows land in seconds).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runWorkflow } from "@/lib/workflows/executor";

export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const w = await prisma.workflow.findUnique({
    where: { slug: params.slug },
    select: { id: true },
  });
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Query param ?dryRun=1 skips ACTION_* side effects; everything
  // else runs normally so the operator can observe the graph flow
  // without firing real scrapes/tests/placements.
  const dryRun =
    new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runWorkflow(w.id, "manual", { dryRun });
  return NextResponse.json({ ok: true, dryRun, ...result });
}
