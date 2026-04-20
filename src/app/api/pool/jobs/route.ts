import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const jobType = url.searchParams.get("type") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  const where: import("@prisma/client").Prisma.PoolJobWhereInput = {};
  if (status) where.status = status;
  if (jobType) where.jobType = jobType;
  if (platform) where.platform = platform;

  const [rows, total] = await Promise.all([
    prisma.poolJob.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.poolJob.count({ where }),
  ]);

  return NextResponse.json({ rows, total, limit, offset });
}
