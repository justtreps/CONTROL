// Duplicate a workflow → creates a new `custom` flow with a
// "-copy[-N]" slug suffix, same nodes, isActive=false.

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const src = await prisma.workflow.findUnique({
    where: { slug: params.slug },
  });
  if (!src) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Find a free slug — `foo-copy`, `foo-copy-2`, …
  const base = `${src.slug}-copy`;
  let candidate = base;
  for (let i = 2; i < 1000; i++) {
    const exists = await prisma.workflow.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!exists) break;
    candidate = `${base}-${i}`;
  }

  const created = await prisma.workflow.create({
    data: {
      slug: candidate,
      displayName: `${src.displayName} (copie)`,
      description: src.description,
      category: "custom",
      triggerType: "manual",
      cronExpression: null,
      eventType: null,
      isActive: false,
      nodes: src.nodes as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ ok: true, workflow: created });
}
