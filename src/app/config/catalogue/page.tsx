// MyBoost product catalogue dashboard.
//
// Stack:
//   • 8 product cards (live counts + top-3 avg score)
//   • scoring status (scored count + latest scored age)
//   • global actions: REMATCHER / RESCORER
//   • drawer (client-side) for detail + per-candidate exclude/include

import { DashboardHeader } from "@/components/DashboardHeader";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { CatalogueClient } from "./CatalogueClient";

export const dynamic = "force-dynamic";

export default async function CataloguePage() {
  const products = await prisma.myBoostProduct.findMany({
    orderBy: [{ platform: "asc" }, { productType: "asc" }],
  });

  const rows = await Promise.all(
    products.map(async (p) => {
      const [total, eligible, topThree] = await Promise.all([
        prisma.productServiceCandidate.count({ where: { productId: p.id } }),
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
          // currentScore is updated inline by rescoreSingleService;
          // rank is stamped only by the 10-min scoring cron's
          // recomputeRanks(). Sorting by rank lags reality —
          // a freshly-scored top service can be missing from
          // top-3 until the cron fires. Sort by the live field.
          orderBy: [
            { currentScore: { sort: "desc", nulls: "last" } },
            { id: "asc" },
          ],
          take: 3,
          select: { currentScore: true },
        }),
      ]);
      const topThreeAvg =
        topThree.length > 0
          ? topThree.reduce(
              (acc, r) => acc + (r.currentScore ?? 0),
              0
            ) / topThree.length
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

  return (
    <>
      <DashboardHeader />
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-10">
        <div className="max-w-7xl mx-auto flex flex-col gap-4">
          <Link
            href="/config"
            className="interactive font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase"
          >
            ← CONFIG
          </Link>
          <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
            [ CATALOGUE MYBOOST · 8 SKUs ]
          </div>
          <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
            Catalogue<br />
            <span className="text-[#FF3300]">produit.</span>
          </h1>
          <p className="font-mono text-xs text-[#666666] normal-case leading-relaxed max-w-3xl">
            Les 8 SKUs MyBoost définissent ce que tu vends. CONTROL match
            automatiquement les services BulkMedya qui correspondent, les
            teste, les score, et les range par rang. Le router pioche le
            rang 1 à chaque commande et descend en cas d&apos;échec provider.
          </p>
        </div>
      </section>

      <CatalogueClient
        initialRows={rows}
        scoringStatus={{
          scoredCount,
          latestScoredAt: latestScored?.lastScoredAt?.toISOString() ?? null,
        }}
      />
    </>
  );
}
