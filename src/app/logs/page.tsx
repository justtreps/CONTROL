import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { LogsFilters } from "./LogsFilters";
import type { Prisma } from "@prisma/client";

export const revalidate = 30;

const PAGE_SIZE = 50;
const RANGES: Record<string, number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

function parseRange(v: string | undefined): number | null {
  if (!v || !(v in RANGES)) return RANGES["7d"];
  return RANGES[v];
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const range = parseRange(searchParams.range);
  const platform = searchParams.platform ?? "all";
  const status = searchParams.status ?? "all";
  const mode = searchParams.mode ?? "all";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);

  const where: Prisma.RoutingDecisionWhereInput = {};
  if (range !== null) {
    where.decidedAt = { gte: new Date(Date.now() - range * 3600 * 1000) };
  }
  if (platform !== "all") where.platform = platform;
  if (status === "success") where.success = true;
  if (status === "fail") where.success = false;
  if (mode === "dry") where.dryRun = true;
  if (mode === "real") where.dryRun = false;

  const last24h = new Date(Date.now() - 24 * 3600 * 1000);

  const [rows, total, platforms, last24, last24Success, scoreAgg] =
    await Promise.all([
      prisma.routingDecision.findMany({
        where,
        orderBy: { decidedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.routingDecision.count({ where }),
      prisma.routingDecision.findMany({
        distinct: ["platform"],
        select: { platform: true },
      }),
      prisma.routingDecision.count({
        where: { decidedAt: { gte: last24h } },
      }),
      prisma.routingDecision.count({
        where: { decidedAt: { gte: last24h }, success: true },
      }),
      prisma.routingDecision.aggregate({
        where: { decidedAt: { gte: last24h }, chosenServiceScore: { not: null } },
        _avg: { chosenServiceScore: true },
      }),
    ]);

  const successRate = last24 > 0 ? (last24Success / last24) * 100 : null;
  const avgScore = scoreAgg._avg.chosenServiceScore;

  const serviceIds = Array.from(
    new Set(
      rows
        .map((r) => r.chosenServiceId)
        .filter((v): v is number => v != null)
    )
  );
  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds } },
    select: { id: true, name: true, platform: true },
  });
  const serviceById = new Map(services.map((s) => [s.id, s]));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const synthCards = [
    { num: "01", label: "DERNIÈRES 24H", value: String(last24), suffix: "DÉCISIONS" },
    {
      num: "02",
      label: "TAUX DE SUCCÈS",
      value: successRate !== null ? `${successRate.toFixed(0)}` : "—",
      suffix: successRate !== null ? "%" : "",
    },
    {
      num: "03",
      label: "SCORE MOYEN",
      value: avgScore !== null && avgScore !== undefined ? avgScore.toFixed(0) : "—",
      suffix: "",
    },
  ];

  return (
    <>
      <DashboardHeader />

      {/* === Pattern C — Header === */}
      <section className="py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-12 border-b border-[#666666]/20 pb-16">
          <div className="md:col-span-4 flex flex-col justify-between gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ JOURNAL DE ROUTAGE | FLUX EN DIRECT ]
            </div>
            <h1
              className="brand font-display tracking-tight uppercase leading-none text-white"
              style={{ fontSize: "clamp(2rem, 4.5vw, 4rem)" }}
            >
              Historique<br />des Décisions.
            </h1>
            <div className="font-mono text-xs text-[#666666] tracking-widest tabular-nums">
              {total} DÉCISIONS POUR CE FILTRE
            </div>
          </div>
          <div className="md:col-span-8 flex flex-col justify-end pt-12 md:pt-0">
            <LogsFilters
              platforms={platforms.map((p) => p.platform).sort()}
              current={{
                range: searchParams.range ?? "7d",
                platform,
                status,
                mode,
              }}
            />
          </div>
        </div>
      </section>

      {/* === Pattern D compact — Synthèse === */}
      <section className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
          [ SYNTHÈSE 24H ]
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 w-full border-b border-[#666666]/20">
          {synthCards.map((c, i) => {
            const bg = i % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
            const borderRight =
              i < synthCards.length - 1
                ? "md:border-r border-[#666666]/20"
                : "";
            return (
              <div key={c.num} className={`p-8 md:p-12 ${bg} ${borderRight}`}>
                <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-6">
                  {c.num}. {c.label}
                </div>
                <div className="brand font-display text-5xl md:text-6xl tabular-nums text-white">
                  {c.value}
                  {c.suffix && (
                    <span className="text-[#666666] text-2xl ml-2">
                      {c.suffix}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* === Pattern E — Table === */}
      <section className="px-4 md:px-8 py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-24">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
                <tr className="border-b border-[#666666]/20">
                  <th className="text-left px-4 py-3 font-normal">Date</th>
                  <th className="text-left px-3 py-3 font-normal">Plat.</th>
                  <th className="text-left px-3 py-3 font-normal">Type</th>
                  <th className="text-right px-3 py-3 font-normal">Qté</th>
                  <th className="text-left px-3 py-3 font-normal">Service choisi</th>
                  <th className="text-center px-3 py-3 font-normal">Score</th>
                  <th className="text-center px-3 py-3 font-normal">Statut</th>
                  <th className="text-center px-3 py-3 font-normal">Mode</th>
                  <th className="text-right px-3 py-3 font-normal">Tent.</th>
                  <th className="text-left px-3 py-3 font-normal">ID BM / Erreur</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const service = r.chosenServiceId
                    ? serviceById.get(r.chosenServiceId)
                    : null;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
                    >
                      <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-[#666666] tabular-nums">
                        {r.decidedAt
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 19)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                        {r.platform}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                        {r.serviceType}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                        {r.quantity}
                      </td>
                      <td className="px-3 py-3 max-w-xs">
                        {service ? (
                          <Link
                            href={`/services/${service.id}`}
                            className="interactive brand font-display text-sm uppercase tracking-tight text-white hover:text-[#FF3300] truncate block transition-colors"
                            title={service.name}
                          >
                            {service.name}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-[#666666]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className="font-mono text-xs text-white tabular-nums">
                          {r.chosenServiceScore !== null
                            ? r.chosenServiceScore.toFixed(0)
                            : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={`font-mono text-xs tracking-widest uppercase ${
                            r.success ? "text-[#00FF88]" : "text-[#FF3300]"
                          }`}
                        >
                          {r.success ? "SUCCÈS" : "ÉCHEC"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={`font-mono text-xs tracking-widest uppercase ${
                            r.dryRun ? "text-[#FFCC00]" : "text-[#FF3300]"
                          }`}
                        >
                          {r.dryRun ? "TEST" : "RÉEL"}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                        {r.attempts}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#666666] max-w-sm truncate">
                        {r.success ? r.bulkmedyaOrderId : r.errorMessage ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
                AUCUNE DÉCISION POUR CES FILTRES.
              </div>
            )}
          </div>

          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: ROUTING-LOG ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              LIVE_FEED_01
            </span>
          </div>
        </div>

        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            searchParams={searchParams}
          />
        )}
      </section>
    </>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: Record<string, string | undefined>;
}) {
  const link = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined) params.set(k, v);
    }
    params.set("page", String(p));
    return `/logs?${params.toString()}`;
  };

  return (
    <div className="max-w-7xl mx-auto flex items-center justify-between mt-6 font-mono text-xs tracking-widest uppercase">
      <div className="text-[#666666] tabular-nums">
        [ PAGE {String(page).padStart(2, "0")} / {String(totalPages).padStart(2, "0")} ]
      </div>
      <div className="flex gap-3">
        {page > 1 && (
          <Link
            href={link(page - 1)}
            className="interactive border border-[#666666]/30 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors"
          >
            ← PRÉCÉDENT
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={link(page + 1)}
            className="interactive border border-[#666666]/30 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors"
          >
            SUIVANT →
          </Link>
        )}
      </div>
    </div>
  );
}
