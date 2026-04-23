import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PLATFORM,
  DEFAULT_TYPE,
  SCOPE,
  getPlatform,
} from "@/lib/scope";
import { ServicesNav } from "./ServicesNav";
import { ServicesTable, type ServiceRow } from "./ServicesTable";

export const dynamic = "force-dynamic";

function resolveSelection(sp: { platform?: string; type?: string }) {
  const platformId = sp.platform ?? DEFAULT_PLATFORM;
  const platform = getPlatform(platformId);
  if (!platform || !platform.enabled) {
    return { platform: DEFAULT_PLATFORM, type: DEFAULT_TYPE };
  }
  const typeId = sp.type ?? DEFAULT_TYPE;
  const type = platform.types.find((t) => t.id === typeId && t.mvp);
  if (!type) {
    const firstMvp = platform.types.find((t) => t.mvp);
    return {
      platform: platform.id,
      type: (firstMvp?.id ?? DEFAULT_TYPE) as string,
    };
  }
  return { platform: platform.id, type: type.id as string };
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: { platform?: string; type?: string };
}) {
  const { platform, type } = resolveSelection(searchParams);

  const services = await prisma.service.findMany({
    where: { active: true, platform, serviceType: type },
    orderBy: { name: "asc" },
    include: {
      scores: {
        orderBy: { computedAt: "desc" },
        take: 30,
      },
      _count: { select: { testOrders: true } },
    },
  });

  const rows: ServiceRow[] = services.map((s) => {
    const latest = s.scores[0] ?? null;
    const history = [...s.scores]
      .reverse()
      .slice(-30)
      .map((sc) => sc.currentScore);
    return {
      id: s.id,
      bulkmedyaId: s.bulkmedyaId,
      name: s.name,
      category: s.category,
      platform: s.platform,
      serviceType: s.serviceType,
      ratePerK: s.ratePerK,
      minQuantity: s.minQuantity,
      maxQuantity: s.maxQuantity,
      refillSupported: s.refillSupported,
      testOrderCount: s._count.testOrders,
      currentScore: latest?.currentScore ?? null,
      completionFactor: latest?.completionFactor ?? null,
      realismScore: latest?.realismScore ?? null,
      speedScore: latest?.speedScore ?? null,
      dropScore: latest?.dropScore ?? null,
      history,
      poolType: s.poolType,
      targetCountry: s.targetCountry,
      classificationManualReview: s.classificationManualReview,
    };
  });

  const totalInScope = await prisma.service.count({
    where: {
      active: true,
      platform: { in: SCOPE.platforms.filter((p) => p.enabled).map((p) => p.id) },
    },
  });

  // Classification stats — computed over ALL active services (not
  // just the current platform/type tab) so the header number doesn't
  // flip every time the user changes tab.
  const scopeWhere = {
    active: true,
    platform: { in: SCOPE.platforms.filter((p) => p.enabled).map((p) => p.id) },
  };
  const [byPoolType, geoTargeted] = await Promise.all([
    prisma.service.groupBy({
      by: ["poolType"],
      where: scopeWhere,
      _count: { _all: true },
    }),
    prisma.service.count({
      where: { ...scopeWhere, targetCountry: { not: null } },
    }),
  ]);
  const poolCounts = {
    follower_test: 0,
    engagement_test: 0,
    unknown: 0,
  };
  for (const row of byPoolType) {
    if (row.poolType in poolCounts) {
      poolCounts[row.poolType as keyof typeof poolCounts] = row._count._all;
    }
  }
  const manualReviewCount = await prisma.service.count({
    where: { ...scopeWhere, classificationManualReview: true },
  });

  const top =
    rows.find((r) => r.currentScore !== null) ??
    (rows.length ? rows[0] : null);

  return (
    <>
      <DashboardHeader />

      {/* === Pattern C — Header === */}
      <section className="py-16 md:py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 border-b border-[#666666]/20 pb-12 md:pb-16">
          <div className="md:col-span-4 min-w-0 flex flex-col justify-between gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ANNUAIRE DES SERVICES | SCOPE: {totalInScope} ACTIFS ]
            </div>
            <h1
              className="brand font-display tracking-tight uppercase leading-none text-white break-words"
              style={{ fontSize: "clamp(2rem, 4.5vw, 4rem)" }}
            >
              Annuaire<br />des Services.
            </h1>
          </div>
          <div className="md:col-span-8 min-w-0 flex flex-col justify-end gap-4 pt-8 md:pt-0">
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase leading-relaxed">
              CATALOGUE DES SERVICES BULKMEDYA DANS LE SCOPE MVP.
              SÉLECTIONNE UNE PLATEFORME ET UN TYPE POUR FILTRER.
            </p>
            <div className="font-mono text-[11px] tracking-widest uppercase flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-[#FF3300]">
                {poolCounts.follower_test} ABONNÉS
              </span>
              <span className="text-[#7DD3FC]">
                {poolCounts.engagement_test} ENGAGEMENT
              </span>
              <span className="text-[#FFCC00]">
                {manualReviewCount} MANUEL
              </span>
              <span className="text-[#666666]">
                {geoTargeted} GÉO-CIBLÉS
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Hierarchical nav: platform tabs > type chips */}
      <ServicesNav activePlatform={platform} activeType={type} />

      {/* Top service for current selection (Pattern D compact) */}
      {top && top.currentScore !== null && (
        <section className="w-full">
          <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
            [ MEILLEUR — {platform.toUpperCase()} / {type.toUpperCase()} ]
          </div>
          <Link
            href={`/services/${top.id}`}
            className="group relative block p-6 md:p-12 bg-[#030303] hover:bg-[#0D0D0D] transition-colors duration-500 interactive border-b border-[#666666]/20"
          >
            <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4">
              [ {top.platform} / {top.serviceType} · #{top.bulkmedyaId} ]
            </div>
            <div className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white break-words mb-4">
              {top.name}
            </div>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <ScoreBadge score={top.currentScore} />
              <span className="font-mono text-xs text-[#666666] tracking-widest">
                {top.testOrderCount} TESTS
              </span>
            </div>
          </Link>
        </section>
      )}

      {/* === Pattern E — Table === */}
      <section className="px-4 md:px-8 py-16 md:py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-20 md:pb-24">
          <ServicesTable rows={rows} />
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: SERVICES-INDEX ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              REGISTRY_NODE_01
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
