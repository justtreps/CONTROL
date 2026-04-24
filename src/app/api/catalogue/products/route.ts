// List of MyBoost products with aggregate metrics per card:
//   • candidatesTotal       — any ProductServiceCandidate row
//   • candidatesEligible    — !forceExcluded && isEligible
//   • topThreeAvgScore      — avg(currentScore) of top-3 ranked rows
// Session-authed via middleware.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const products = await prisma.myBoostProduct.findMany({
    orderBy: [{ platform: "asc" }, { productType: "asc" }],
  });

  // Aggregates per product — one round-trip each. Bounded to 8
  // products so the sequential N+1 is fine.
  const rows = await Promise.all(
    products.map(async (p) => {
      const [total, eligible, topThree] = await Promise.all([
        prisma.productServiceCandidate.count({
          where: { productId: p.id },
        }),
        prisma.productServiceCandidate.count({
          where: {
            productId: p.id,
            isEligible: true,
            forceExcluded: false,
          },
        }),
        prisma.productServiceCandidate.findMany({
          where: {
            productId: p.id,
            isEligible: true,
            forceExcluded: false,
            currentScore: { not: null },
          },
          orderBy: [{ rank: { sort: "asc", nulls: "last" } }],
          take: 3,
          select: { currentScore: true },
        }),
      ]);
      const topThreeAvg =
        topThree.length > 0
          ? topThree.reduce((acc, r) => acc + (r.currentScore ?? 0), 0) /
            topThree.length
          : null;
      return {
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
        isActive: p.isActive,
        candidatesTotal: total,
        candidatesEligible: eligible,
        topThreeAvgScore: topThreeAvg,
      };
    })
  );

  // Scoring status — number of scored candidates + age of the latest
  // score so the UI can surface freshness.
  const [scoredCount, latestScored] = await Promise.all([
    prisma.productServiceCandidate.count({
      where: { currentScore: { not: null } },
    }),
    prisma.productServiceCandidate.findFirst({
      where: { lastScoredAt: { not: null } },
      orderBy: { lastScoredAt: "desc" },
      select: { lastScoredAt: true },
    }),
  ]);

  return NextResponse.json({
    products: rows,
    scoringStatus: {
      scoredCount,
      latestScoredAt: latestScored?.lastScoredAt ?? null,
    },
  });
}
