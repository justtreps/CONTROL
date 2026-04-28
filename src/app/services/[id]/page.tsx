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

export const dynamic = "force-dynamic";

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

  // Cost-efficiency percentile of THIS service across the catalog.
  // Mirrors the calculation in lib/scoring.ts:runScoringEngine —
  // computed live so a service whose product/category cost
  // distribution shifts gets a fresh percentile here.
  const allScorable = await prisma.service.findMany({
    where: {
      active: true,
      testOrders: { some: { status: "completed" } },
    },
    select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true },
  });
  const myCost = (() => {
    const qty = Math.max(20, service.minQuantity);
    if (service.maxQuantity > 0 && qty > service.maxQuantity) return null;
    return (service.ratePerK * qty) / 1000;
  })();
  const allCosts = allScorable
    .map((s) => {
      const qty = Math.max(20, s.minQuantity);
      if (s.maxQuantity > 0 && qty > s.maxQuantity) return null;
      return (s.ratePerK * qty) / 1000;
    })
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  let costPercentile = 0.5;
  let costPts = 0;
  if (myCost !== null && allCosts.length > 1) {
    const rank = allCosts.findIndex((c) => c >= myCost);
    costPercentile = rank / (allCosts.length - 1);
    if (costPercentile <= 0.25) costPts = 15;
    else if (costPercentile <= 0.50) costPts = 10;
    else if (costPercentile <= 0.75) costPts = 5;
    else costPts = 0;
  }
  // Display 0-100 normalized: cost component is 0-15 pts → ×6.66
  const costScoreDisplay = Math.round((costPts / 15) * 100);

  // Drop is stored on legacy 0-50 scale (dropPtsAvg × 10, max
  // 5 × 10). Rescale to 0-100 so the breakdown is consistent.
  const dropDisplay = (s: number) => Math.min(100, s * 2);

  // Bayesian smoothing constants — must match
  // lib/scoring.ts:runScoringEngine. With PRIOR_WEIGHT=1, the
  // anchor for n=0 is 50; with n=1 a raw=100 sub-score weights
  // to (100+50)/2 = 75 — same math as the global weighted score.
  // This is the fix for the "Total 75 vs all subs 100" mismatch:
  // we now apply the SAME Bayesian smoothing to each sub before
  // display, so the numbers reconcile.
  const PRIOR = 50;
  const PRIOR_WEIGHT = 1;
  const bayesian = (raw: number | null, n: number): number | null => {
    if (raw === null) return null;
    return (raw * n + PRIOR * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
  };
  const sampleCount = latest?.sampleCount ?? 0;

  // Build raw + weighted views per sub-score. The chart uses
  // weighted to match the Total line; the breakdown shows
  // weighted big + raw subtitle for transparency.
  const subRawNow = latest
    ? {
        completion: latest.completionFactor * 100,
        speed: latest.speedScore,
        drop: dropDisplay(latest.dropScore),
        cost: costScoreDisplay,
      }
    : null;
  const subRawOld = sevenDayBaseline
    ? {
        completion: sevenDayBaseline.completionFactor * 100,
        speed: sevenDayBaseline.speedScore,
        drop: dropDisplay(sevenDayBaseline.dropScore),
        cost: costScoreDisplay,
      }
    : null;

  const scorePoints: ScorePoint[] = service.scores.map((s) => {
    const n = s.sampleCount;
    return {
      t: s.computedAt.toISOString(),
      total: round1(s.currentScore),
      completion: round1(bayesian(s.completionFactor * 100, n) ?? 0),
      speed: round1(bayesian(s.speedScore, n) ?? 0),
      drop: round1(bayesian(dropDisplay(s.dropScore), n) ?? 0),
      cost: round1(bayesian(costScoreDisplay, n) ?? 0),
    };
  });

  const subScores: Array<{
    num: string;
    label: string;
    value: number | null;
    old: number | null;
    raw: number | null;
  }> = [
    {
      num: "01",
      label: "Score total",
      value: latest?.currentScore ?? null,
      old: sevenDayBaseline?.currentScore ?? null,
      raw: latest?.rawScore ?? null,
    },
    {
      num: "02",
      label: "Livraison",
      value: bayesian(subRawNow?.completion ?? null, sampleCount),
      old: bayesian(
        subRawOld?.completion ?? null,
        sevenDayBaseline?.sampleCount ?? 0
      ),
      raw: subRawNow?.completion ?? null,
    },
    {
      num: "03",
      label: "Vitesse",
      value: bayesian(subRawNow?.speed ?? null, sampleCount),
      old: bayesian(
        subRawOld?.speed ?? null,
        sevenDayBaseline?.sampleCount ?? 0
      ),
      raw: subRawNow?.speed ?? null,
    },
    {
      num: "04",
      label: "Drop",
      value: bayesian(subRawNow?.drop ?? null, sampleCount),
      old: bayesian(
        subRawOld?.drop ?? null,
        sevenDayBaseline?.sampleCount ?? 0
      ),
      raw: subRawNow?.drop ?? null,
    },
    {
      num: "05",
      label: "Coût",
      value: bayesian(subRawNow?.cost ?? null, sampleCount),
      old: bayesian(
        subRawOld?.cost ?? null,
        sevenDayBaseline?.sampleCount ?? 0
      ),
      raw: subRawNow?.cost ?? null,
    },
  ];

  // Confidence label — drives the colored chip next to the
  // breakdown header so the operator sees at a glance how much
  // weight to put on these numbers.
  const confidenceLabel = (() => {
    if (sampleCount === 0)
      return { text: "AUCUN TEST RULE-1", color: "#666666" };
    if (sampleCount === 1)
      return { text: `n=1 — CONFIANCE FAIBLE`, color: "#FF3300" };
    if (sampleCount < 5)
      return { text: `n=${sampleCount} — CONFIANCE MOYENNE`, color: "#FFCC00" };
    if (sampleCount < 10)
      return { text: `n=${sampleCount} — CONFIANCE BONNE`, color: "#00CC66" };
    return { text: `n=${sampleCount} — CONFIANCE HAUTE`, color: "#00FF88" };
  })();

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
      status: o.status,
      retryCount: o.retryCount,
      abortReason: o.abortReason,
    };
  });

  return (
    <>
      <DashboardHeader />

      {/* === Pattern B — Hero === */}
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-10 md:pb-12">
        <div className="max-w-7xl mx-auto">
          <Link
            href="/services"
            className="font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase interactive"
          >
            ← TOUS LES SERVICES
          </Link>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-end mt-6 md:mt-8">
            <div className="lg:col-span-8 min-w-0 flex flex-col">
              <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max max-w-full truncate">
                [ SERVICE ID: {service.bulkmedyaId} | PLATEFORME:{" "}
                {service.platform.toUpperCase()} | TYPE:{" "}
                {service.serviceType.toUpperCase()} ]
              </div>
              <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0 break-words">
                {service.name}
              </h1>
            </div>
            <div className="lg:col-span-4 min-w-0 font-mono text-xs tracking-widest uppercase">
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
      <section className="px-4 md:px-8 py-16 md:py-24">
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
      <section className="px-4 md:px-8 py-16 md:py-24">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 border-b border-[#666666]/20 pb-16 md:pb-24">
          <div className="md:col-span-4 min-w-0 flex flex-col justify-between gap-6 md:gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ DÉCOMPOSITION DU SCORE | MOYENNE 30J ]
            </div>
            <h2
              className="brand font-display tracking-tight uppercase leading-none text-white break-words"
              style={{ fontSize: "clamp(1.75rem, 3.5vw, 3rem)" }}
            >
              Décomposition<br />du Score.
            </h2>
            <div className="flex flex-col gap-3 mt-2">
              <span
                className="font-mono text-[10px] tracking-widest uppercase border px-2 py-1 w-max"
                style={{
                  color: confidenceLabel.color,
                  borderColor: confidenceLabel.color,
                }}
              >
                [ {confidenceLabel.text} ]
              </span>
              <p className="font-mono text-[10px] text-[#666666] tracking-widest leading-relaxed normal-case">
                Score affiché = pondéré Bayesian sur n={sampleCount} test
                {sampleCount > 1 ? "s" : ""}. Avec n=1, chaque sub-score
                tend vers 50 (anchor neutre); à n=10+ il converge vers
                sa valeur brute. Total = somme pondérée des composantes.
              </p>
            </div>
          </div>
          <div className="md:col-span-8 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-8 lg:gap-10 pt-6 md:pt-0">
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
                  {s.raw !== null && s.num !== "01" && (
                    <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                      RAW {s.raw.toFixed(0)} · n={sampleCount}
                    </div>
                  )}
                  {s.num === "01" && s.raw !== null && (
                    <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                      RAW {s.raw.toFixed(0)} · n={sampleCount}
                    </div>
                  )}
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
          <div className="px-4 md:px-8 py-16 md:py-24 text-center font-mono text-xs text-[#666666] tracking-widest uppercase border-b border-[#666666]/20">
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
                  <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-4 flex items-center gap-2 flex-wrap">
                    <span>
                      {o.placedAt
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 16)}{" "}
                      UTC
                    </span>
                    {o.retryCount > 0 && (
                      <span
                        className="font-mono text-[10px] tracking-widest uppercase border border-[#FFCC00] text-[#FFCC00] px-1.5 py-0"
                        title={`Auto-retry chain depth ${o.retryCount} — target died mid-test, re-placed on fresh target.`}
                      >
                        RETRY {o.retryCount}/3
                      </span>
                    )}
                    {o.status === "aborted_target_died" && (
                      <span
                        className="font-mono text-[10px] tracking-widest uppercase border border-[#FF3300] text-[#FF3300] px-1.5 py-0"
                        title={o.abortReason ?? "target died mid-test"}
                      >
                        ABORT TARGET DEAD
                      </span>
                    )}
                    {o.status === "running" && (
                      <span
                        className="font-mono text-[10px] tracking-widest uppercase border border-[#666666]/60 text-[#666666] px-1.5 py-0"
                      >
                        EN COURS
                      </span>
                    )}
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
