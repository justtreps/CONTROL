import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") ?? undefined;
  const where: import("@prisma/client").Prisma.PoolSeedAccountWhereInput = {};
  if (platform && platform !== "all") where.platform = platform;
  const rows = await prisma.poolSeedAccount.findMany({
    where,
    orderBy: [{ platform: "asc" }, { priority: "desc" }, { username: "asc" }],
  });
  return NextResponse.json({ rows });
}

const createSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  username: z.string().min(1).max(64),
  priority: z.number().int().optional(),
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
    const row = await prisma.poolSeedAccount.create({ data: parsed.data });
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Unique")) {
      return NextResponse.json(
        { error: "Déjà enregistré pour cette plateforme." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
