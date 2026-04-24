// Detail endpoint — returns the workflow metadata + its full nodes
// JSON for the read-only graph renderer.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
