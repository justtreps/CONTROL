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
  // before the next scoring cron tick stamps Service.reliabilityFactor.
  const reliability = await computeReliabilityForService(id);
  const relChip = reliabilityChip(reliability.factor);

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
    // Cost is reverse-engineered from the RAW (pre-factor) total
    // since the four sub-scores live in the raw space (4×25=100).
    // ServiceScore rows written before the reliability-factor refactor
    // stored rawScore = currentScore (no factor), so the math still
    // works for historical points.
    const rawTotal = s.rawScore || s.currentScore;
    const cost = Math.max(0, rawTotal - livraison - vitesse - drop);
    return {
      t: s.computedAt.toISOString(),
      total: round1(s.currentScore),
      completion: round1(livraison),
      speed: round1(vitesse),
      drop: round1(drop),
      cost: round1(cost),
    };
  });

  // Score brut = the pre-factor 4×25 total written by the engine
  // into ServiceScore.rawScore. Historical rows (pre-refactor)
  // stored rawScore equal to currentScore, so the fallback keeps
  // their breakdown self-consistent.
  const latestRaw = latest ? latest.rawScore || latest.currentScore : null;
  const oldRaw = sevenDayBaseline
    ? sevenDayBaseline.rawScore || sevenDayBaseline.currentScore
    : null;

  const subScores: Array<{
    num: string;
    label: string;
    value: number | null;
    old: number | null;
    max: number;
    /** Custom right-hand label (e.g. "× 0.85") instead of "/max". */
    valueOverride?: string;
    /** Optional sub-line shown below the big number. */
    subline?: string;
    /** Optional chip rendered next to the label. */
    chip?: { label: string; color: string };
  }> = [
    {
      num: "01",
      label: "Score final",
      value: latest?.currentScore ?? null,
      old: sevenDayBaseline?.currentScore ?? null,
      max: 100,
    },
    {
      num: "02",
      label: "Score brut",
      value: latestRaw,
      old: oldRaw,
      max: 100,
      subline:
        "Somme des 4 sous-scores avant l'ajustement fiabilité.",
    },
    {
      num: "03",
      label: "Livraison",
      value: latest ? latest.completionFactor * SUB_MAX : null,
      old: sevenDayBaseline ? sevenDayBaseline.completionFactor * SUB_MAX : null,
      max: SUB_MAX,
    },
    {
      num: "04",
      label: "Vitesse",
      value: latest?.speedScore ?? null,
      old: sevenDayBaseline?.speedScore ?? null,
      max: SUB_MAX,
    },
    {
      num: "05",
      label: "Drop",
      value: latest?.dropScore ?? null,
      old: sevenDayBaseline?.dropScore ?? null,
      max: SUB_MAX,
    },
    {
      num: "06",
      label: "Coût",
      value: coutSub,
      old: coutSub,
      max: SUB_MAX,
    },
    {
      num: "07",
      label: "Fiabilité",
      // 1.0 fallback when below MIN_SAMPLES — chip stays null so
      // the operator sees no penalty applied.
      value: reliability.factor,
      old: null,
      max: 1,
      valueOverride:
        reliability.factor === null
          ? `× 1.00`
          : `× ${reliability.factor.toFixed(2)}`,
      subline:
        reliability.factor === null
          ? `Pas encore de pénalité — ${reliability.totalFinalized}/${RELIABILITY_MIN_SAMPLES} test(s) finalisé(s).`
          : `${reliability.perfect} perfect · ${reliability.partial} partial · ${reliability.fail} fail (sur ${reliability.totalFinalized})`,
      chip: relChip
        ? {
            label: relChip.label,
            color:
              relChip.color === "green"
                ? "#00CC66"
                : relChip.color === "blue"
                  ? "#7DD3FC"
                  : relChip.color === "yellow"
                    ? "#FFCC00"
                    : "#FF3300",
          }
        : undefined,
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

  // Identify the parent service's true metric (likes / views / etc.)
  // — this is the source of truth for what the test SHOULD be
  // measuring. A TestOrder placed pre-fix on an engagement service
  // routed to the follower pool (testAccountId set, testPostId null)
  // should display as "TEST CASSÉ" so an operator scanning the card
  // doesn't mistake the zero delivery for poor service quality.
  const ENGAGEMENT_METRICS = [
    "likes",
    "like",
    "views",
    "view",
    "plays",
    "play",
    "comments",
    "comment",
    "shares",
    "share",
    "saves",
    "save",
    "bookmarks",
    "favorites",
    "favourites",
  ];
  const serviceIsEngagement = ENGAGEMENT_METRICS.includes(
    service.serviceType.toLowerCase(),
  );
  const formatMetricLabel = (raw: string | null | undefined): string => {
    const m = (raw ?? "").toUpperCase();
    if (m === "LIKES" || m === "LIKE") return "LIKES";
    if (m === "VIEWS" || m === "VIEW" || m === "PLAYS") return "VUES";
    if (m === "COMMENTS") return "COMMENTAIRES";
    if (m === "SHARES") return "PARTAGES";
    if (m === "SAVES" || m === "BOOKMARKS" || m === "FAVORITES") return "SAVES";
    if (m === "FOLLOWERS") return "ABONNÉS";
    return m || "—";
  };

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
    // Three relevant flow states:
    //  - Healthy engagement test: targetType="post", testPost set
    //  - Healthy follower test:   targetType="account", testAccount set, parent service is followers
    //  - BROKEN engagement test:  parent service is engagement BUT testPost is null
    //                              (placed on follower pool — pre-fix legacy)
    const isEngagementFlow = o.targetType === "post";
    const isBrokenEngagement =
      serviceIsEngagement && !o.testPostId;
    const targetLabel = isEngagementFlow
      ? o.testPost?.mediaUrl ?? "[ POST INTROUVABLE ]"
      : `@${o.testAccount.username}`;
    // Metric label always reflects the PARENT SERVICE'S serviceType,
    // so a broken engagement card still shows "LIKES" even though the
    // row was tracking followers. The big warning chip below makes
    // the broken state unmistakable.
    const targetMetricLabel = formatMetricLabel(
      o.targetMetric ?? service.serviceType,
    );
    // State chip — replaces the previous "EN COURS" / status mix
    // that was confusing operators on fresh-just-placed tests
    // (showed "0 livré" with no indication that the poll hadn't
    // fired yet).
    const stateChip = (() => {
      // Highest-priority signal: the row is from the broken
      // engagement-on-follower-pool legacy. Override every other
      // status so the operator can't miss it. Aborted-misplaced
      // rows are guaranteed to also start with "aborted_" so this
      // branch fires before the generic aborted handler.
      if (isBrokenEngagement) {
        return {
          label: `TEST CASSÉ — engagement placé sur compte (legacy)`,
          color: "#FF3300",
          bg: "rgba(255, 51, 0, 0.16)",
          title:
            "Service engagement (likes/views/etc.) testé via le pool follower avant le fix du 2026-05-02. " +
            "Ce TestOrder n'a jamais mesuré le bon métrique — la livraison réelle BulkMedya a été refusée. " +
            "Marqué aborted_misplaced; n'entre pas dans le score / la fiabilité. Un nouveau retest post-flow va remplacer cette donnée.",
        };
      }
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
      isEngagement: isEngagementFlow,
      isBrokenEngagement,
      // Only render as a clickable link when the row is a HEALTHY
      // engagement flow (post URL). Broken-engagement rows display
      // the parent account username instead so the operator can see
      // what was wrongly tested.
      targetIsLink: isEngagementFlow,
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
                Score brut = livraison + vitesse + drop + coût (4 × 25 = 100).
                Score final = brut × fiabilité (0.5 - 1.0). Calculé sur le
                DERNIER TestOrder finalisé — pas de moyenne mobile.
                La fiabilité ne pénalise qu&apos;à partir de {RELIABILITY_MIN_SAMPLES} tests
                finalisés ; en dessous, facteur 1.0 (pas de pénalité).
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
                s.value !== null && s.old !== null && !s.valueOverride
                  ? s.value - s.old
                  : null;
              return (
                <div key={s.num} className="flex flex-col gap-2">
                  <div className="h-px w-full bg-[#666666]/30" />
                  <h3 className="font-mono text-xs tracking-widest text-[#666666] uppercase flex items-center gap-2 flex-wrap">
                    <span>
                      {s.num}. {s.label}
                    </span>
                    {s.chip && (
                      <span
                        className="font-mono text-[10px] tracking-widest uppercase border px-1.5 py-0"
                        style={{ color: s.chip.color, borderColor: s.chip.color }}
                      >
                        [ {s.chip.label} ]
                      </span>
                    )}
                  </h3>
                  <div className="brand font-display text-4xl md:text-5xl tabular-nums text-white">
                    {s.valueOverride
                      ? s.valueOverride
                      : s.value !== null
                        ? s.value.toFixed(0)
                        : "—"}
                    {!s.valueOverride && (
                      <span className="text-[#666666] text-base md:text-lg ml-2">
                        / {s.max}
                      </span>
                    )}
                  </div>
                  {s.subline && (
                    <p className="font-mono text-[10px] text-[#666666] tracking-widest leading-relaxed normal-case">
                      {s.subline}
                    </p>
                  )}
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
