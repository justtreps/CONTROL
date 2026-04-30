import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { LogsFilters } from "./LogsFilters";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

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
  const view = searchParams.view === "testbot" ? "testbot" : "routing";
  const range = parseRange(searchParams.range);
  const platform = searchParams.platform ?? "all";
  const status = searchParams.status ?? "all";
  const mode = searchParams.mode ?? "all";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);

  if (view === "testbot") {
    return <TestbotJournal searchParams={searchParams} />;
  }

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
    select: { id: true, bulkmedyaId: true, name: true, platform: true },
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

      <ViewSwitcher current="routing" />

      {/* === Pattern C — Header === */}
      <section className="py-16 md:py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 border-b border-[#666666]/20 pb-12 md:pb-16">
          <div className="md:col-span-4 min-w-0 flex flex-col justify-between gap-6 md:gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ JOURNAL DE ROUTAGE | FLUX EN DIRECT ]
            </div>
            <h1
              className="brand font-display tracking-tight uppercase leading-none text-white break-words"
              style={{ fontSize: "clamp(2rem, 4.5vw, 4rem)" }}
            >
              Historique<br />des Décisions.
            </h1>
            <div className="font-mono text-xs text-[#666666] tracking-widest tabular-nums">
              {total} DÉCISIONS POUR CE FILTRE
            </div>
          </div>
          <div className="md:col-span-8 min-w-0 flex flex-col justify-end pt-6 md:pt-0">
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
              <div key={c.num} className={`p-6 md:p-12 ${bg} ${borderRight}`}>
                <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4 md:mb-6">
                  {c.num}. {c.label}
                </div>
                <div className="brand font-display text-4xl md:text-6xl tabular-nums text-white break-words">
                  {c.value}
                  {c.suffix && (
                    <span className="text-[#666666] text-xl md:text-2xl ml-2">
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
      <section className="px-4 md:px-8 py-16 md:py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-20 md:pb-24">
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
                          <div className="flex flex-col min-w-0">
                            <Link
                              href={`/services/${service.id}`}
                              className="interactive brand font-display text-sm uppercase tracking-tight text-white hover:text-[#FF3300] truncate block transition-colors"
                              title={`${service.name} [#${service.bulkmedyaId}]`}
                            >
                              {service.name}
                            </Link>
                            <span className="font-mono text-[10px] text-[#FF3300]/80 tracking-widest">
                              #{service.bulkmedyaId}
                            </span>
                          </div>
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

// ── View switcher — routing (MyBoost /api/order traffic) vs
// testbot (TestOrders placed by the scoring campaign). Lives at
// the top of both views so operators can flip without guessing
// the URL.
function ViewSwitcher({ current }: { current: "routing" | "testbot" }) {
  const tabs: Array<{ id: "routing" | "testbot"; label: string; href: string }> = [
    { id: "routing", label: "ROUTAGE /api/order", href: "/logs" },
    { id: "testbot", label: "TESTBOT (campagne scoring)", href: "/logs?view=testbot" },
  ];
  return (
    <div className="px-4 md:px-8 pt-10">
      <div className="max-w-7xl mx-auto flex gap-0 border border-[#666666]/20">
        {tabs.map((t) => {
          const active = t.id === current;
          return (
            <Link
              key={t.id}
              href={t.href}
              className={`interactive flex-1 px-4 py-3 text-center font-mono text-[11px] tracking-widest uppercase transition-colors border-r border-[#666666]/20 last:border-r-0 ${
                active
                  ? "bg-[#FF3300] text-black"
                  : "bg-[#030303] text-[#666666] hover:text-white"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── Testbot journal — real TestOrders placed by the scoring
// campaign (live + terminal). Status is derived from OUR state
// (status field + completedAt), never from BulkMedya. "Mesure
// actuelle" reads the latest non-T+0 Measurement's actualCount so
// the operator sees the RapidAPI-observed progress, not whatever
// BulkMedya claims.
async function TestbotJournal({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const range = parseRange(searchParams.range);
  const platformFilter = searchParams.platform ?? "all";
  const statusFilter = searchParams.status ?? "all";
  const modeFilter = searchParams.mode ?? "all";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);

  const where: Prisma.TestOrderWhereInput = {};
  if (range !== null) {
    where.placedAt = { gte: new Date(Date.now() - range * 3600 * 1000) };
  }
  if (platformFilter !== "all") where.service = { platform: platformFilter };
  if (statusFilter === "running") where.status = "running";
  if (statusFilter === "completed") where.status = "completed";
  if (statusFilter === "aborted") where.status = { startsWith: "aborted" };
  if (modeFilter === "dry") where.dryRun = true;
  if (modeFilter === "real") where.dryRun = false;

  const last24h = new Date(Date.now() - 24 * 3600 * 1000);

  const [rows, total, last24, last24Completed] = await Promise.all([
    prisma.testOrder.findMany({
      where,
      include: {
        service: {
          select: { id: true, name: true, platform: true, bulkmedyaId: true },
        },
        measurements: {
          orderBy: { checkedAt: "desc" },
          take: 1,
          where: { checkpoint: { not: "T+0" } },
        },
      },
      orderBy: { placedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.testOrder.count({ where }),
    prisma.testOrder.count({
      where: { placedAt: { gte: last24h } },
    }),
    prisma.testOrder.count({
      where: { placedAt: { gte: last24h }, status: "completed" },
    }),
  ]);

  // Scoring readiness ratio — how many of the last-24h orders pass
  // RULE 1 today. Definition of RULE 1 (see lib/scoring.ts:
  // pickLatestScorableTest): "TestOrder that has at least 1 non-T+0
  // Measurement". The previous formula here checked `peak >
  // baselineCount` (= test that DELIVERED), which is a STRICTER
  // condition than RULE 1 itself; "scorable" means "polled at all",
  // not "polled with delivery". Audit reported the mismatch — the
  // synth card was answering a different question than its label.
  // Also the measurements include pulled all rows (T+0 included),
  // so even `length > 0` would have always been true without the
  // checkpoint filter inside the include.
  const eligible24 = await prisma.testOrder.findMany({
    where: { placedAt: { gte: last24h } },
    include: {
      measurements: {
        where: { checkpoint: { not: "T+0" } },
        select: { id: true },
        take: 1,
      },
    },
    take: 1000,
  });
  const scorable = eligible24.filter((o) => o.measurements.length > 0).length;
  const scorablePct = eligible24.length > 0
    ? Math.round((scorable / eligible24.length) * 100)
    : null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const synthCards = [
    { num: "01", label: "DERNIÈRES 24H", value: String(last24), suffix: "TESTS PLACÉS" },
    {
      num: "02",
      label: "COMPLÉTÉS 24H",
      value: String(last24Completed),
      suffix: last24 > 0 ? `/ ${last24}` : "",
    },
    {
      num: "03",
      label: "SCORABLES RULE 1",
      value: scorablePct !== null ? String(scorablePct) : "—",
      suffix: scorablePct !== null ? "%" : "",
    },
  ];

  return (
    <>
      <DashboardHeader />
      <ViewSwitcher current="testbot" />

      <section className="py-16 md:py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 border-b border-[#666666]/20 pb-12 md:pb-16">
          <div className="md:col-span-4 min-w-0 flex flex-col justify-between gap-6 md:gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ JOURNAL TESTBOT | PLACEMENTS CAMPAGNE ]
            </div>
            <h1
              className="brand font-display tracking-tight uppercase leading-none text-white break-words"
              style={{ fontSize: "clamp(2rem, 4.5vw, 4rem)" }}
            >
              Tests<br />Testbot.
            </h1>
            <div className="font-mono text-xs text-[#666666] tracking-widest tabular-nums">
              {total} PLACEMENTS POUR CE FILTRE
            </div>
            <div className="font-mono text-[10px] text-[#666666]/60 tracking-widest uppercase max-w-sm leading-relaxed">
              Le statut affiché vient de notre état interne — jamais de BulkMedya. La mesure actuelle est lue via RapidAPI.
            </div>
          </div>
          <div className="md:col-span-8 min-w-0 flex flex-col justify-end pt-6 md:pt-0">
            <LogsFilters
              platforms={["instagram", "tiktok"]}
              current={{
                range: searchParams.range ?? "7d",
                platform: platformFilter,
                status: statusFilter,
                mode: modeFilter,
              }}
              statusOptions={[
                { value: "all", label: "Tous" },
                { value: "running", label: "En cours" },
                { value: "completed", label: "Complétés" },
                { value: "aborted", label: "Abortés" },
              ]}
            />
          </div>
        </div>
      </section>

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
              <div key={c.num} className={`p-6 md:p-12 ${bg} ${borderRight}`}>
                <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4 md:mb-6">
                  {c.num}. {c.label}
                </div>
                <div className="brand font-display text-4xl md:text-6xl tabular-nums text-white break-words">
                  {c.value}
                  {c.suffix && (
                    <span className="text-[#666666] text-xl md:text-2xl ml-2">
                      {c.suffix}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="px-4 md:px-8 py-16 md:py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-20 md:pb-24">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
                <tr className="border-b border-[#666666]/20">
                  <th className="text-left px-4 py-3 font-normal">Placé</th>
                  <th className="text-left px-3 py-3 font-normal">Plat.</th>
                  <th className="text-left px-3 py-3 font-normal">Service</th>
                  <th className="text-right px-3 py-3 font-normal">Qté cible</th>
                  <th className="text-right px-3 py-3 font-normal">Baseline</th>
                  <th className="text-right px-3 py-3 font-normal">Mesure</th>
                  <th className="text-right px-3 py-3 font-normal">Livré</th>
                  <th className="text-center px-3 py-3 font-normal">Statut</th>
                  <th className="text-center px-3 py-3 font-normal">Mode</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = r.measurements[0];
                  const actual = m?.actualCount ?? null;
                  const delivered = actual !== null
                    ? Math.max(0, actual - r.baselineCount)
                    : null;
                  const deliveredPct = delivered !== null && r.targetQuantity > 0
                    ? Math.round((delivered / r.targetQuantity) * 100)
                    : null;
                  const statusColor = statusColorFor(r.status);
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
                    >
                      <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-[#666666] tabular-nums">
                        {r.placedAt.toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                        {r.service.platform}
                      </td>
                      <td className="px-3 py-3 max-w-xs">
                        <Link
                          href={`/services/${r.service.id}`}
                          className="interactive brand font-display text-sm uppercase tracking-tight text-white hover:text-[#FF3300] truncate block transition-colors"
                          title={`${r.service.name} [#${r.service.bulkmedyaId}]`}
                        >
                          {r.service.name}
                        </Link>
                        <span className="font-mono text-[10px] text-[#FF3300]/80 tracking-widest">
                          #{r.service.bulkmedyaId}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                        {r.targetQuantity}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                        {r.baselineCount}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                        {actual ?? "—"}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                        {delivered !== null ? (
                          <span className={delivered > 0 ? "text-[#00FF88]" : "text-[#666666]"}>
                            {delivered}
                            {deliveredPct !== null && (
                              <span className="text-[#666666] ml-1">
                                ({deliveredPct}%)
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[#666666]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className="font-mono text-xs tracking-widest uppercase"
                          style={{ color: statusColor }}
                        >
                          {r.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span
                          className={`font-mono text-xs tracking-widest uppercase ${
                            r.dryRun ? "text-[#FFCC00]" : "text-[#FF3300]"
                          }`}
                        >
                          {r.dryRun ? "SIM" : "RÉEL"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
                AUCUN TEST POUR CES FILTRES.
              </div>
            )}
          </div>

          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: TESTBOT-LOG ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              LIVE_MEASUREMENTS_01
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

function statusColorFor(status: string): string {
  if (status === "completed") return "#00FF88";
  if (status === "running") return "#66CCFF";
  if (status.startsWith("aborted")) return "#FF3300";
  return "#666666";
}
