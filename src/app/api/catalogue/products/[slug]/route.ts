// Product detail — loaded by the drawer on /config/catalogue.
// Returns the product metadata + every candidate with the fields
// the drawer table needs: service name, bulkmedyaId, score, rank,
// lastTestedAt, geo, eligibility flags.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const product = await prisma.myBoostProduct.findUnique({
    where: { slug: params.slug },
  });
  if (!product) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const candidates = await prisma.productServiceCandidate.findMany({
    where: { productId: product.id },
    // Live currentScore is primary; rank is a 10-min-cron-refreshed
    // denormalisation kept on the row for display only.
    orderBy: [
      { currentScore: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    include: {
      service: {
        select: {
          id: true,
          bulkmedyaId: true,
          name: true,
          platform: true,
          ratePerK: true,
          minQuantity: true,
          maxQuantity: true,
          lastTestedAt: true,
          active: true,
        },
      },
    },
  });

  return NextResponse.json({
    product: {
      id: product.id,
      slug: product.slug,
      displayName: product.displayName,
      platform: product.platform,
      productType: product.productType,
      isActive: product.isActive,
    },
    candidates: candidates.map((c) => ({
      id: c.id,
      rank: c.rank,
      currentScore: c.currentScore,
      isEligible: c.isEligible,
      forceExcluded: c.forceExcluded,
      targetCountry: c.targetCountry,
      lastScoredAt: c.lastScoredAt?.toISOString() ?? null,
      service: {
        ...c.service,
        lastTestedAt: c.service.lastTestedAt?.toISOString() ?? null,
      },
    })),
  });
}
