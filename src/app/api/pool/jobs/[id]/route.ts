import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await prisma.poolJob.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ row });
}

// Hard-delete a PoolJob row. Only allowed on terminal rows — a live
// worker could still be writing progress to a running/pending job
// and we'd lose the checkpoint. Stuck rows are the common target:
// the [ SUPPRIMER ] button on a stuck active-jobs row calls here.
// No FKs point at PoolJob so no cascade concerns.
const DELETABLE_STATUSES = new Set([
  "stuck",
  "stopped",
  "completed",
  "error",
]);

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await prisma.poolJob.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!DELETABLE_STATUSES.has(row.status)) {
    return NextResponse.json(
      {
        error: "invalid_status",
        message: `Cannot delete a job in status="${row.status}" — stop it first.`,
      },
      { status: 409 }
    );
  }

  await prisma.poolJob.delete({ where: { id } });
  return NextResponse.json({ ok: true, deletedJobId: id });
}
