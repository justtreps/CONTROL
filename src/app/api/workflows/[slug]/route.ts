// Detail + update + delete. Used by the visual editor to fetch the
// current graph, persist edits, and retire custom workflows.

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateWorkflowGraph } from "@/lib/workflows/validate";
import type { NodesArray } from "@/lib/workflows/nodes";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const w = await prisma.workflow.findUnique({
    where: { slug: params.slug },
  });
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workflow: w });
}

const updateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z
    .enum(["health", "pool", "scoring", "sync", "catalogue", "custom"])
    .optional(),
  triggerType: z.enum(["manual", "cron", "event"]).optional(),
  cronExpression: z.string().max(100).nullable().optional(),
  eventType: z.string().max(100).nullable().optional(),
  nodes: z.array(z.any()).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  if (parsed.data.nodes) {
    const v = validateWorkflowGraph(parsed.data.nodes as NodesArray);
    if (!v.ok) {
      return NextResponse.json(
        { error: "invalid_graph", details: v.errors },
        { status: 400 }
      );
    }
  }
  try {
    const w = await prisma.workflow.update({
      where: { slug: params.slug },
      data: parsed.data as unknown as Prisma.WorkflowUpdateInput,
    });
    return NextResponse.json({ ok: true, workflow: w });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  try {
    // Guard: never delete a seeded workflow — they're re-upserted on
    // every /api/workflows/seed call anyway. We gate by category so
    // the operator can delete `custom` ones they built from scratch
    // but not wreck the baseline flows.
    const existing = await prisma.workflow.findUnique({
      where: { slug: params.slug },
      select: { category: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (existing.category !== "custom") {
      return NextResponse.json(
        {
          error: "protected_seed_workflow",
          message:
            "Only `custom` workflows can be deleted. Désactive plutôt ce workflow.",
        },
        { status: 409 }
      );
    }
    await prisma.workflow.delete({ where: { slug: params.slug } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
