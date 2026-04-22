import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SORTABLE = new Set([
  "firstSeenAt",
  "lastCheckedAt",
  "lastFollowerCount",
  "username",
  "platform",
  "status",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const limit = Math.min(
    100,
    Number(url.searchParams.get("limit") ?? 50) || 50
  );
  const sort = url.searchParams.get("sort") ?? "firstSeenAt";
  const order =
    (url.searchParams.get("order") ?? "desc").toLowerCase() === "asc"
      ? "asc"
      : "desc";

  const accountType = url.searchParams.get("accountType") ?? undefined;
  const country = url.searchParams.get("country") ?? undefined;

  const where: import("@prisma/client").Prisma.TestAccountWhereInput = {};
  if (platform && platform !== "all") where.platform = platform;
  if (status && status !== "all") where.status = status;
  if (source && source !== "all") where.scrapeSource = source;
  if (accountType && accountType !== "all")
    (where as Record<string, unknown>).accountType = accountType;
  if (country && country !== "all") {
    if (country === "unknown") {
      (where as Record<string, unknown>).detectedCountry = null;
    } else {
      (where as Record<string, unknown>).detectedCountry = country;
    }
  }
  if (q.trim()) {
    where.OR = [
      { username: { contains: q.trim(), mode: "insensitive" } },
      { userId: { contains: q.trim() } },
    ];
  }

  const orderBy = SORTABLE.has(sort)
    ? { [sort]: order }
    : { firstSeenAt: "desc" };

  const [rows, total] = await Promise.all([
    prisma.testAccount.findMany({
      where,
      orderBy: orderBy as import("@prisma/client").Prisma.TestAccountOrderByWithRelationInput,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.testAccount.count({ where }),
  ]);

  return NextResponse.json({
    rows,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}
