import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import {
  computeCostPercentileForService,
  pickLatestScorableTest,
} from "@/lib/scoring";
import {
  computeReliabilityForService,
  reliabilityChip,
  RELIABILITY_WINDOW,
  RELIABILITY_MIN_SAMPLES,
} from "@/lib/scoring/reliability";
import { getPollIntervalMin } from "@/lib/system/toggles";
import {
  ServiceDetailCharts,
  type ScorePoint,
} from "./ServiceDetailCharts";
import { ServiceDetailActions } from "./ServiceDetailActions";

export const dynamic = "force-dynamic";

const SUB_MAX = 25;

export default async function ServiceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return notFound();

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  // Operator-configurable polling cadence (SystemToggle).
  // Threaded into the FRESH chip label so the card matches reality
  // even after the operator bumps the cadence on /config.
  const pollIntervalMin = await getPollIntervalMin();

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
          // Engagement test orders carry a TestPost. Including it here
          // lets the card render the post permalink + the right metric
          // label (likes / views / etc.) instead of the parent
          // username, which was the wrong target for engagement tests.
          testPost: true,
          measurements: { orderBy: { checkedAt: "asc" } },
        },
      },
    },
  });

  if (!service) return notFound();

  const latest = service.scores[service.scores.length - 1] ?? null;
  const sevenDayBaseline =
    service.scores.find((s) => s.computedAt.getTime() >= sevenDaysAgo) ?? null;

  // Cost percentile + scorable test picker share their definition
  // with lib/scoring.ts. Inlining either of those calculations here
  // is a math-drift trap — the detail page used to use a bracket
  // formula (15/10/5/0) and a `status="completed"` cohort filter,
  // both of which diverged from the engine's linear-percentile +
  // polled-cohort formula. The Coût sub-score shown on the page
  // didn't add up to the headline currentScore. Now we call the
  // same helpers the engine calls so they cannot drift.
  const costPercentile = await computeCostPercentileForService(id);
  const coutSub = SUB_MAX * (1 - Math.min(1, Math.max(0, costPercentile)));

  // The "latest scorable test" the engine used. Falls back to null
  // if the service has zero polled tests. Use this for the
  // freshness chip + the "dernier test placé" caption — anything
  // that previously said "dernier test FINALISÉ" lied when the
  // service had a fresh running-but-polled test that overrode the
  // older completed one in the score.
  const scorableOrder = await pickLatestScorableTest(id);
  const latestTestAt = scorableOrder?.completedAt ?? null;
  const latestTestPlacedAt = scorableOrder?.placedAt ?? null;

  // Reliability (historical fault rate) — same buckets as the chip
  // helper. Computed live so a freshly-finalised test is reflected
  // before the next scoring cron tick stamps Service.reliabilityScore.
  const reliability = await computeReliabilityForService(id);
  const relChip = reliabilityChip(reliability.score);

  // The Coût sub-score is computed live (off the *current* catalog
  // cost distribution), not stored per-snapshot in ServiceScore. So
  // we can't honestly chart its history — we only know today's
  // value. Reverse-engineer it from each snapshot's
  //   total = livraison + vitesse + drop + coût
  // which is exact since the engine writes all four directly. This
  // way the cost line moves with whatever percentile that snapshot
  // implied, not a flat line of today's value (the previous bug
  // made every historical "coût" point identical to the current
  // value, which read like a stable cost while the score wobbled).
  const scorePoints: ScorePoint[] = service.scores.map((s) => {
    const livraison = s.completionFactor * SUB_MAX;
    const vitesse = s.speedScore;
    const drop = s.dropScore;
    const cost = Math.max(0, s.currentScore - livraison - vitesse - drop);
    return {
      t: s.computedAt.toISOString(),
      total: round1(s.currentScore),
      completion: round1(livraison),
      speed: round1(vitesse),
      drop: round1(drop),
      cost: round1(cost),
    };
  });

  const subScores: Array<{
    num: string;
    label: string;
    value: number | null;
    old: number | null;
    max: number;
  }> = [
    {
      num: "01",
      label: "Score total",
      value: latest?.currentScore ?? null,
      old: sevenDayBaseline?.currentScore ?? null,
      max: 100,
    },
    {
      num: "02",
      label: "Livraison",
      value: latest ? latest.completionFactor * SUB_MAX : null,
      old: sevenDayBaseline ? sevenDayBaseline.completionFactor * SUB_MAX : null,
      max: SUB_MAX,
    },
    {
      num: "03",
      label: "Vitesse",
      value: latest?.speedScore ?? null,
      old: sevenDayBaseline?.speedScore ?? null,
      max: SUB_MAX,
    },
    {
      num: "04",
      label: "Drop",
      value: latest?.dropScore ?? null,
      old: sevenDayBaseline?.dropScore ?? null,
      max: SUB_MAX,
    },
    {
      num: "05",
      label: "Coût",
      value: coutSub,
      old: coutSub,
      max: SUB_MAX,
    },
  ];

  // Freshness chip — based on how old the latest *scorable* test
  // is. We anchor on placedAt (not completedAt) because the engine
  // now scores on placed-but-still-running tests too: a test placed
  // 2h ago that's already polled once is fresher than a completed
  // test from 5 days ago, even though the latter has a completedAt.
  const freshnessLabel = (() => {
    if (!latestTestPlacedAt) {
      return { text: "AUCUN TEST POLLÉ", color: "#666666" };
    }
    const ageH = (Date.now() - latestTestPlacedAt.getTime()) / 3600_000;
    if (ageH < 12) return { text: `TEST < 12H — FRAIS`, color: "#00FF88" };
    if (ageH < 36) return { text: `TEST ${Math.round(ageH)}H — RÉCENT`, color: "#00CC66" };
    if (ageH < 72) return { text: `TEST ${Math.round(ageH)}H — DÛ POUR RETEST`, color: "#FFCC00" };
    return { text: `TEST ${Math.round(ageH)}H — STALE`, color: "#FF3300" };
  })();

  const orderCards = service.testOrders.map((o) => {
    const ms = o.measurements;
    const polled = ms.filter((m) => m.checkpoint !== "T+0");
    const peak = ms.length > 0 ? Math.max(...ms.map((m) => m.actualCount)) : o.baselineCount;
    const delivered = Math.max(0, peak - o.baselineCount);
    const deliveredPct = Math.min(
      100,
      (delivered / Math.max(1, o.targetQuantity)) * 100
    );
    const latestM = ms[ms.length - 1];
    // Engagement vs follower flow — drives the card label (post URL
    // vs @username) AND the unit shown next to "LIVRÉ" so the
    // operator can immediately tell if a TestOrder for a "likes"
    // service is correctly tracking likes (not followers).
    const isEngagement = o.targetType === "post";
    const targetLabel = isEngagement
      ? o.testPost?.mediaUrl ?? "[ POST INTROUVABLE ]"
      : `@${o.testAccount.username}`;
    const targetMetricLabel = (() => {
      if (!isEngagement) return "ABONNÉS";
      const m = (o.targetMetric ?? service.serviceType).toUpperCase();
      // Map historical aliases to the user-facing word.
      if (m === "LIKES" || m === "LIKE") return "LIKES";
      if (m === "VIEWS" || m === "VIEW" || m === "PLAYS") return "VUES";
      if (m === "COMMENTS") return "COMMENTAIRES";
      if (m === "SHARES") return "PARTAGES";
      if (m === "SAVES" || m === "BOOKMARKS" || m === "FAVORITES") return "SAVES";
      return m;
    })();
    // State chip — replaces the previous "EN COURS" / status mix
    // that was confusing operators on fresh-just-placed tests
    // (showed "0 livré" with no indication that the poll hadn't
    // fired yet).
    const stateChip = (() => {
      if (o.status.startsWith("aborted")) {
        const reason = o.abortReason ?? o.status;
        return {
          label: `ABORTÉ — ${reason.slice(0, 40)}`,
          color: "#FF3300",
          bg: "rgba(255, 51, 0, 0.10)",
          title: o.abortReason ?? undefined,
        };
      }
      if (o.status === "completed_partial") {
        return {
          label: `STAGNÉ — finalisé partial (${deliveredPct.toFixed(0)} %)`,
          color: "#FFCC00",
          bg: "rgba(255, 204, 0, 0.10)",
          title: "Stagnation détectée: 3 polls identiques + age ≥24h.",
        };
      }
      if (o.status === "completed") {
        if (deliveredPct >= 100) {
          return {
            label: `LIVRÉ 100 %`,
            color: "#00CC66",
            bg: "rgba(0, 204, 102, 0.10)",
            title: undefined,
          };
        }
        return {
          label: `PARTIEL ${deliveredPct.toFixed(0)} %`,
          color: "#FFCC00",
          bg: "rgba(255, 204, 0, 0.10)",
          title: undefined,
        };
      }
      // status === "running" (or other non-terminal) below
      if (polled.length === 0) {
        const label =
          pollIntervalMin >= 60
            ? `FRESH — premier poll dans ${Math.round(pollIntervalMin / 60)} h`
            : `FRESH — premier poll dans ${pollIntervalMin} min`;
        return {
          label,
          color: "#7DD3FC",
          bg: "rgba(125, 211, 252, 0.10)",
          title: `Test placé. La 1re mesure RapidAPI fire ${pollIntervalMin} min après le placement.`,
        };
      }
      return {
        label: `EN COURS — ${delivered}/${o.targetQuantity}`,
        color: "#FF8533",
        bg: "rgba(255, 133, 51, 0.10)",
        title: `${polled.length} poll(s) déjà landed`,
      };
    })();
    return {
      id: o.id,
      placedAt: o.placedAt,
      // Legacy field name retained for backward-compat with the
      // existing card markup, but content depends on flow.
      account: targetLabel,
      isEngagement,
      targetIsLink: isEngagement,
      targetMetricLabel,
      delivered,
      quantity: o.targetQuantity,
      deliveredPct,
      checkpoint: latestM?.checkpoint ?? "—",
      bulkmedyaOrderId: o.bulkmedyaOrderId,
      status: o.status,
      retryCount: o.retryCount,
      abortReason: o.abortReason,
      stateChip,
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
              [ DÉCOMPOSITION DU SCORE | DERNIER TEST ]
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
                  color: freshnessLabel.color,
                  borderColor: freshnessLabel.color,
                }}
              >
                [ {freshnessLabel.text} ]
              </span>
              <p className="font-mono text-[10px] text-[#666666] tracking-widest leading-relaxed normal-case">
                Score = livraison + vitesse + drop + coût (4 × 25 = 100).
                Calculé sur le DERNIER TestOrder finalisé. Plus de moyenne
                mobile, plus de smoothing — chaque retest réécrit le
                score. Service testé régulièrement = score à jour.
              </p>
              {latestTestPlacedAt && (
                <p className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                  Dernier test placé{" "}
                  {latestTestPlacedAt.toISOString().slice(0, 10)} ·{" "}
                  {latestTestAt
                    ? `finalisé ${latestTestAt.toISOString().slice(0, 10)}`
                    : "EN COURS"}
                </p>
              )}
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
                    <span className="text-[#666666] text-base md:text-lg ml-2">
                      / {s.max}
                    </span>
                  </div>
                  {delta !== null && Math.abs(delta) > 0.01 && (
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

      {/* === Pattern C-bis — Fiabilité historique === */}
      <section className="px-4 md:px-8 py-12 md:py-16 border-t border-[#666666]/20">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12">
          <div className="md:col-span-4 min-w-0 flex flex-col gap-4">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ FIABILITÉ HISTORIQUE | TIE-BREAKER ]
            </div>
            <h2
              className="brand font-display tracking-tight uppercase leading-none text-white break-words"
              style={{ fontSize: "clamp(1.5rem, 2.6vw, 2.25rem)" }}
            >
              Fiabilité<br />du Service.
            </h2>
            <p className="font-mono text-[10px] text-[#666666] tracking-widest leading-relaxed normal-case">
              Score 0-10 sur les {RELIABILITY_WINDOW} derniers tests
              finalisés. Formule&nbsp;:
              {" (perfect − partial − 2·fail) / "}
              {RELIABILITY_WINDOW}&nbsp;× 10. Sert de tie-breaker dans le
              ranking quand deux services ont le même <em>currentScore</em>
              {" "}— celui qui a livré sans faute passe au-dessus.
            </p>
          </div>
          <div className="md:col-span-8 min-w-0">
            {reliability.score === null ? (
              <div className="font-mono text-xs text-[#666666] tracking-widest uppercase border border-[#666666]/30 px-4 py-8 text-center">
                PAS ASSEZ D&apos;HISTORIQUE — {reliability.samples} TEST
                {reliability.samples === 1 ? "" : "S"} FINALISÉ
                {reliability.samples === 1 ? "" : "S"} (MIN.{" "}
                {RELIABILITY_MIN_SAMPLES} POUR CALCUL).
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="flex flex-col gap-3">
                  <div className="h-px w-full bg-[#666666]/30" />
                  <h3 className="font-mono text-xs tracking-widest text-[#666666] uppercase">
                    Score
                  </h3>
                  <div className="brand font-display text-5xl md:text-6xl tabular-nums text-white">
                    {reliability.score.toFixed(1)}
                    <span className="text-[#666666] text-3xl">/10</span>
                  </div>
                  {relChip && (
                    <span
                      className="font-mono text-[10px] tracking-widest uppercase border px-2 py-1 w-max"
                      style={{
                        color:
                          relChip.color === "green"
                            ? "#00CC66"
                            : relChip.color === "blue"
                              ? "#7DD3FC"
                              : relChip.color === "yellow"
                                ? "#FFCC00"
                                : "#FF3300",
                        borderColor:
                          relChip.color === "green"
                            ? "#00CC66"
                            : relChip.color === "blue"
                              ? "#7DD3FC"
                              : relChip.color === "yellow"
                                ? "#FFCC00"
                                : "#FF3300",
                      }}
                    >
                      [ {relChip.label} ]
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-3 sm:col-span-2">
                  <div className="h-px w-full bg-[#666666]/30" />
                  <h3 className="font-mono text-xs tracking-widest text-[#666666] uppercase">
                    Décomposition (sur {reliability.samples} tests)
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        Perfect
                      </span>
                      <span
                        className="brand font-display text-3xl md:text-4xl tabular-nums"
                        style={{ color: "#00CC66" }}
                      >
                        {reliability.perfect}
                      </span>
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest normal-case">
                        livré ≥ target
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        Partial
                      </span>
                      <span
                        className="brand font-display text-3xl md:text-4xl tabular-nums"
                        style={{ color: "#FFCC00" }}
                      >
                        {reliability.partial}
                      </span>
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest normal-case">
                        0 &lt; livré &lt; target
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        Fail
                      </span>
                      <span
                        className="brand font-display text-3xl md:text-4xl tabular-nums"
                        style={{ color: "#FF3300" }}
                      >
                        {reliability.fail}
                      </span>
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest normal-case">
                        livré = 0
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
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
                    <span
                      className="font-mono text-[10px] tracking-widest uppercase border px-1.5 py-0"
                      style={{
                        color: o.stateChip.color,
                        borderColor: o.stateChip.color,
                        backgroundColor: o.stateChip.bg,
                      }}
                      title={o.stateChip.title}
                    >
                      {o.stateChip.label}
                    </span>
                  </div>
                  {o.targetIsLink ? (
                    <a
                      href={o.account}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="brand font-display text-lg uppercase tracking-tight text-white truncate mb-1 block hover:text-[#FF3300] transition-colors interactive"
                      title={`Test engagement (${o.targetMetricLabel.toLowerCase()}) — ouvrir le post`}
                    >
                      {o.account}
                    </a>
                  ) : (
                    <div className="brand font-display text-lg uppercase tracking-tight text-white truncate mb-1">
                      {o.account}
                    </div>
                  )}
                  <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-6">
                    QTÉ : {o.quantity} {o.targetMetricLabel}
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                      LIVRÉ ({o.targetMetricLabel})
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
