// List + create workflows.

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateWorkflowGraph } from "@/lib/workflows/validate";
import type { NodesArray } from "@/lib/workflows/nodes";

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

const createSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "slug must be kebab-case a-z 0-9 and dashes"),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z
    .enum(["health", "pool", "scoring", "sync", "catalogue", "custom"])
    .default("custom"),
  triggerType: z.enum(["manual", "cron", "event"]).default("manual"),
  cronExpression: z.string().max(100).nullable().optional(),
  eventType: z.string().max(100).nullable().optional(),
  nodes: z.array(z.any()).default([]),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  if (parsed.data.nodes.length > 0) {
    const v = validateWorkflowGraph(parsed.data.nodes as NodesArray);
    if (!v.ok) {
      return NextResponse.json(
        { error: "invalid_graph", details: v.errors },
        { status: 400 }
      );
    }
  }
  try {
    const w = await prisma.workflow.create({
      data: {
        slug: parsed.data.slug,
        displayName: parsed.data.displayName,
        description: parsed.data.description ?? null,
        category: parsed.data.category,
        triggerType: parsed.data.triggerType,
        cronExpression: parsed.data.cronExpression ?? null,
        eventType: parsed.data.eventType ?? null,
        nodes:
          parsed.data.nodes as unknown as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({ ok: true, workflow: w });
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg.includes("Unique constraint") ? 409 : 500;
    return NextResponse.json(
      { error: code === 409 ? "slug_taken" : msg },
      { status: code }
    );
  }
}
