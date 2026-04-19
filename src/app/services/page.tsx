import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import { ServicesTable, type ServiceRow } from "./ServicesTable";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const services = await prisma.service.findMany({
    where: { active: true },
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
    };
  });

  // Top 1 per platform for the Pattern D compact bar
  const topByPlatform = new Map<string, ServiceRow>();
  for (const r of rows) {
    if (r.currentScore === null) continue;
    const existing = topByPlatform.get(r.platform);
    if (!existing || (existing.currentScore ?? 0) < r.currentScore) {
      topByPlatform.set(r.platform, r);
    }
  }
  const topRows = Array.from(topByPlatform.values())
    .sort((a, b) => (b.currentScore ?? 0) - (a.currentScore ?? 0))
    .slice(0, 3);

  return (
    <>
      <DashboardHeader />

      {/* === Pattern C — Header === */}
      <section className="py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-12 border-b border-[#666666]/20 pb-16">
          <div className="md:col-span-4 flex flex-col justify-between gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ANNUAIRE DES SERVICES | TOTAL: {services.length} ]
            </div>
            <h1
              className="brand font-display tracking-tight uppercase leading-none text-white"
              style={{ fontSize: "clamp(2rem, 4.5vw, 4rem)" }}
            >
              Annuaire<br />des Services.
            </h1>
          </div>
          <div className="md:col-span-8 flex flex-col justify-end gap-4 pt-12 md:pt-0">
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase leading-relaxed">
              CATALOGUE COMPLET DES SERVICES BULKMEDYA SYNCHRONISÉS. CHAQUE
              LIGNE EST CLIQUABLE POUR ACCÉDER AU DÉTAIL.
            </p>
          </div>
        </div>
      </section>

      {/* === Pattern D compact — Top 1 par plateforme === */}
      {topRows.length > 0 && (
        <section className="w-full">
          <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
            [ MEILLEUR PAR PLATEFORME ]
          </div>
          <div
            className={`grid grid-cols-1 md:grid-cols-${Math.min(
              topRows.length,
              3
            )} w-full border-b border-[#666666]/20`}
          >
            {topRows.map((r, i) => {
              const bg = i % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
              const hoverBg =
                i % 2 === 0 ? "hover:bg-[#0D0D0D]" : "hover:bg-[#030303]";
              const borderRight =
                i < topRows.length - 1
                  ? "md:border-r border-[#666666]/20"
                  : "";
              return (
                <Link
                  key={r.id}
                  href={`/services/${r.id}`}
                  className={`group relative p-8 ${borderRight} ${bg} ${hoverBg} transition-colors duration-500 interactive`}
                >
                  <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4">
                    [ {r.platform} / {r.serviceType} ]
                  </div>
                  <div className="brand font-display text-xl uppercase tracking-tight text-white truncate mb-4">
                    {r.name}
                  </div>
                  <div className="flex items-center justify-between">
                    <ScoreBadge score={r.currentScore} />
                    <span className="font-mono text-xs text-[#666666] tracking-widest">
                      {r.testOrderCount} TESTS
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* === Pattern E — Table === */}
      <section className="px-4 md:px-8 py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-24">
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
