import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  username: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const account = await prisma.testAccount.create({ data: parsed.data });
    return NextResponse.json({ ok: true, id: account.id });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Unique")) {
      return NextResponse.json(
        { error: "Ce compte existe déjà pour cette plateforme." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  await prisma.testAccount.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
