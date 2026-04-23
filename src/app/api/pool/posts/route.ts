// List endpoint for the engagement pool's PRIMARY entity — posts.
// Mirrors /api/pool/accounts shape so the same PoolAccountsList UI
// can pivot between universes without a second hand-rolled client.
//
// A row corresponds to a single TestPost, with its parent account's
// username + detected country joined in for display.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SORTABLE = new Set([
  "firstSeenAt",
  "postedAt",
  "naturalLikesCount",
  "platform",
  "status",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;
  const q = url.searchParams.get("q") ?? "";
  const country = url.searchParams.get("country") ?? undefined;
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

  const where: import("@prisma/client").Prisma.TestPostWhereInput = {};
  if (platform && platform !== "all") where.platform = platform;
  if (status && status !== "all") where.status = status;
  if (source && source !== "all") where.scrapeSource = source;
  if (country && country !== "all") {
    if (country === "unknown") {
      where.testAccount = { detectedCountry: null };
    } else {
      where.testAccount = { detectedCountry: country };
    }
  }
  if (q.trim()) {
    where.OR = [
      { testAccount: { username: { contains: q.trim(), mode: "insensitive" } } },
      { mediaId: { contains: q.trim() } },
    ];
  }

  const orderBy = SORTABLE.has(sort)
    ? { [sort]: order }
    : { firstSeenAt: "desc" };

  const [rows, total] = await Promise.all([
    prisma.testPost.findMany({
      where,
      orderBy:
        orderBy as import("@prisma/client").Prisma.TestPostOrderByWithRelationInput,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        testAccount: {
          select: {
            username: true,
            detectedCountry: true,
            countryConfidence: true,
          },
        },
      },
    }),
    prisma.testPost.count({ where }),
  ]);

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      mediaId: r.mediaId,
      mediaUrl: r.mediaUrl,
      mediaType: r.mediaType,
      postedAt: r.postedAt?.toISOString() ?? null,
      naturalLikesCount: r.naturalLikesCount,
      status: r.status,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastCheckedAt: r.lastCheckedAt.toISOString(),
      testAccountId: r.testAccountId,
      parentUsername: r.testAccount.username,
      detectedCountry: r.testAccount.detectedCountry,
      countryConfidence: r.testAccount.countryConfidence,
      invalidReason: r.invalidReason,
      scrapeSource: r.scrapeSource,
    })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}
