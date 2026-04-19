import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import {
  ServiceDetailCharts,
  type ScorePoint,
} from "./ServiceDetailCharts";
import { ServiceDetailActions } from "./ServiceDetailActions";

export const revalidate = 30;

export default async function ServiceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return notFound();

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;

  const service = await prisma.service.findUnique({
    where: { id },
    include: {
      scores: {
        where: { computedAt: { gte: since } },
        orderBy: { computedAt: "asc" },
      },
      testOrders: {
        orderBy: { placedAt: "desc" },
        take: 9,
        include: {
          testAccount: true,
          measurements: { orderBy: { checkedAt: "asc" } },
        },
      },
    },
  });

  if (!service) return notFound();

  const latest = service.scores[service.scores.length - 1] ?? null;
  const sevenDayBaseline =
    service.scores.find((s) => s.computedAt.getTime() >= sevenDaysAgo) ?? null;

  const scorePoints: ScorePoint[] = service.scores.map((s) => ({
    t: s.computedAt.toISOString(),
    total: round1(s.currentScore),
    completion: round1(s.completionFactor * 100),
    realism: round1(s.realismScore),
    speed: round1(s.speedScore),
    drop: round1(s.dropScore),
  }));

  const subScores = [
    {
      num: "01",
      label: "Score total",
      value: latest?.currentScore ?? null,
      old: sevenDayBaseline?.currentScore ?? null,
    },
    {
      num: "02",
      label: "Livraison",
      value: latest ? latest.completionFactor * 100 : null,
      old: sevenDayBaseline ? sevenDayBaseline.completionFactor * 100 : null,
    },
    {
      num: "03",
      label: "Réalisme",
      value: latest?.realismScore ?? null,
      old: sevenDayBaseline?.realismScore ?? null,
    },
    {
      num: "04",
      label: "Vitesse",
      value: latest?.speedScore ?? null,
      old: sevenDayBaseline?.speedScore ?? null,
    },
    {
      num: "05",
      label: "Drop",
      value: latest?.dropScore ?? null,
      old: sevenDayBaseline?.dropScore ?? null,
    },
  ];

  const orderCards = service.testOrders.map((o) => {
    const ms = o.measurements;
    const peak = ms.length > 0 ? Math.max(...ms.map((m) => m.actualCount)) : o.baselineCount;
    const delivered = Math.max(0, peak - o.baselineCount);
    const deliveredPct = Math.min(
      100,
      (delivered / Math.max(1, o.targetQuantity)) * 100
    );
    const latestM = ms[ms.length - 1];
    return {
      id: o.id,
      placedAt: o.placedAt,
      account: `@${o.testAccount.username}`,
      quantity: o.targetQuantity,
      deliveredPct,
      checkpoint: latestM?.checkpoint ?? "—",
      bulkmedyaOrderId: o.bulkmedyaOrderId,
    };
  });

  return (
    <>
      <DashboardHeader />

      {/* === Pattern B — Hero === */}
      <section className="px-4 md:px-8 pt-32 pb-12">
        <div className="max-w-7xl mx-auto">
          <Link
            href="/services"
            className="font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase interactive"
          >
            ← TOUS LES SERVICES
          </Link>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-end mt-8">
            <div className="lg:col-span-8 flex flex-col">
              <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max">
                [ SERVICE ID: {service.bulkmedyaId} | PLATEFORME:{" "}
                {service.platform.toUpperCase()} ]
              </div>
              <h1 className="brand font-display text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
                {service.name}
              </h1>
            </div>
            <div className="lg:col-span-4 font-mono text-xs tracking-widest uppercase">
              <BriefRow label="Tarif" value={`${service.ratePerK.toFixed(2)} €/K`} />
              <BriefRow label="Min" value={String(service.minQuantity)} />
              <BriefRow label="Max" value={String(service.maxQuantity)} />
              <BriefRow
                label="Refill"
                value={service.refillSupported ? "[ OUI ]" : "[ NON ]"}
                accent={service.refillSupported}
              />
              <BriefRow
                label="Score actuel"
                value={latest ? latest.currentScore.toFixed(0) : "—"}
                accent={Boolean(latest)}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="w-full h-px bg-[#666666]/20" />

      {/* === Pattern E — Graph === */}
      <section className="px-4 md:px-8 py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 p-6 md:p-8 pb-24">
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none z-10">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: {service.bulkmedyaId}-SCORE-HISTORY ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              RENDER_NODE_02
            </span>
          </div>

          {scorePoints.length < 2 ? (
            <div className="py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
              PAS ENCORE ASSEZ DE DONNÉES ({scorePoints.length} POINT
              {scorePoints.length === 1 ? "" : "S"}). LE SCORING ENGINE
              ÉCRIRA DES POINTS AU FIL DU TEMPS.
            </div>
          ) : (
            <ServiceDetailCharts points={scorePoints} />
          )}
        </div>
      </section>

      {/* === Pattern C — Sub-score breakdown === */}
      <section className="px-4 md:px-8 py-24">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-12 border-b border-[#666666]/20 pb-24">
          <div className="md:col-span-4 flex flex-col justify-between gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ DÉCOMPOSITION DU SCORE | MOYENNE 30J ]
            </div>
            <h2
              className="brand font-display tracking-tight uppercase leading-none text-white"
              style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)" }}
            >
              Décomposition<br />du Score.
            </h2>
          </div>
          <div className="md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-8 lg:gap-10 pt-12 md:pt-0">
            {subScores.map((s) => {
              const delta =
                s.value !== null && s.old !== null ? s.value - s.old : null;
              return (
                <div key={s.num} className="flex flex-col gap-3">
                  <div className="h-px w-full bg-[#666666]/30" />
                  <h3 className="font-mono text-xs tracking-widest text-[#666666] uppercase">
                    {s.num}. {s.label}
                  </h3>
                  <div className="brand font-display text-4xl md:text-5xl tabular-nums text-white">
                    {s.value !== null ? s.value.toFixed(0) : "—"}
                  </div>
                  {delta !== null && (
                    <div
                      className={`font-mono text-xs tracking-widest uppercase ${
                        delta > 0
                          ? "text-[#00FF88]"
                          : delta < 0
                            ? "text-[#FF3300]"
                            : "text-[#666666]"
                      }`}
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta.toFixed(1)} PT / 7J
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* === Pattern D — Test orders récents === */}
      <section className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
          [ COMMANDES TEST RÉCENTES | DERNIÈRES {orderCards.length} ]
        </div>
        {orderCards.length === 0 ? (
          <div className="px-8 py-24 text-center font-mono text-xs text-[#666666] tracking-widest uppercase border-b border-[#666666]/20">
            AUCUNE COMMANDE TEST POUR CE SERVICE.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 w-full border-b border-[#666666]/20">
            {orderCards.map((o, i) => {
              const bg = i % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
              const borderRight =
                (i + 1) % 3 !== 0
                  ? "md:border-r border-[#666666]/20"
                  : "";
              const borderBottom =
                i < orderCards.length - 3
                  ? "border-b border-[#666666]/20"
                  : "";
              return (
                <div
                  key={o.id}
                  className={`p-6 md:p-8 ${bg} ${borderRight} ${borderBottom}`}
                >
                  <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4">
                    {o.placedAt
                      .toISOString()
                      .replace("T", " ")
                      .slice(0, 16)}{" "}
                    UTC
                  </div>
                  <div className="brand font-display text-lg uppercase tracking-tight text-white truncate mb-1">
                    {o.account}
                  </div>
                  <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-6">
                    QTÉ : {o.quantity}
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                      LIVRÉ
                    </span>
                    <ScoreBadge score={o.deliveredPct} size="sm" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                      CHECKPOINT
                    </span>
                    <span className="font-mono text-xs text-white tracking-widest">
                      {o.checkpoint}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-[#666666] tracking-widest mt-4 truncate">
                    BM : {o.bulkmedyaOrderId}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* === Pattern F — Actions === */}
      <ServiceDetailActions />
    </>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function BriefRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#666666]/20 last:border-b-0">
      <span className="text-[#666666]">{label}</span>
      <span className={accent ? "text-[#FF3300]" : "text-white"}>{value}</span>
    </div>
  );
}
