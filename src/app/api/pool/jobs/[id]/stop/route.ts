import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await prisma.poolJob.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!["pending", "running"].includes(row.status)) {
    return NextResponse.json(
      { error: "already_terminal", status: row.status },
      { status: 409 }
    );
  }
  await prisma.poolJob.update({
    where: { id },
    data: { stopRequested: true },
  });
  return NextResponse.json({ ok: true });
}
