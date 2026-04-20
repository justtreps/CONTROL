import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.poolUsernamePrefix.findMany({
    orderBy: { prefix: "asc" },
  });
  return NextResponse.json({ rows });
}

const createSchema = z.object({
  prefix: z.string().min(1).max(32),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const row = await prisma.poolUsernamePrefix.create({
      data: { prefix: parsed.data.prefix, enabled: parsed.data.enabled ?? true },
    });
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Unique")) {
      return NextResponse.json({ error: "Déjà enregistré." }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
