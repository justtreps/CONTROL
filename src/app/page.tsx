import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { RunScoringButton, SyncServicesButton } from "./HomeActions";

export const dynamic = "force-dynamic";

type Alert = {
  serviceId: number;
  name: string;
  platform: string;
  latestScore: number;
  oldScore: number;
  diff: number;
};

type TopService = {
  id: number;
  name: string;
  platform: string;
  serviceType: string;
  score: number;
};

async function loadData() {
  const now = Date.now();
  const last24h = new Date(now - 24 * 3600 * 1000);
  const last48h = new Date(now - 48 * 3600 * 1000);
  const last72h = new Date(now - 72 * 3600 * 1000);

  const [activeServices, testAccounts, recentTestOrders, recentRoutes, services] =
    await Promise.all([
      prisma.service.count({ where: { active: true } }),
      prisma.testAccount.count({ where: { active: true } }),
      prisma.testOrder.count({ where: { placedAt: { gte: last24h } } }),
      prisma.routingDecision.count({ where: { decidedAt: { gte: last24h } } }),
      prisma.service.findMany({
        where: { active: true },
        include: {
          scores: {
            where: { computedAt: { gte: last72h } },
            orderBy: { computedAt: "asc" },
          },
        },
      }),
    ]);

  const alerts: Alert[] = [];
  const ranked: TopService[] = [];

  for (const s of services) {
    const sc = s.scores;
    const latest = sc[sc.length - 1];
    if (latest) {
      ranked.push({
        id: s.id,
        name: s.name,
        platform: s.platform,
        serviceType: s.serviceType,
        score: latest.currentScore,
      });
    }
    if (sc.length < 2) continue;
    const target = now - 48 * 3600 * 1000;
    const old = sc.reduce((best, x) =>
      Math.abs(x.computedAt.getTime() - target) <
      Math.abs(best.computedAt.getTime() - target)
        ? x
        : best
    );
    const diff = latest.currentScore - old.currentScore;
    if (diff <= -15 && old.computedAt < last48h) {
      alerts.push({
        serviceId: s.id,
        name: s.name,
        platform: s.platform,
        latestScore: latest.currentScore,
        oldScore: old.currentScore,
        diff,
      });
    }
  }

  alerts.sort((a, b) => a.diff - b.diff);
  ranked.sort((a, b) => b.score - a.score);

  return {
    metrics: [
      { num: "01", label: "Services actifs", value: activeServices },
      { num: "02", label: "Comptes test actifs", value: testAccounts },
      { num: "03", label: "Commandes test 24h", value: recentTestOrders },
      { num: "04", label: "Commandes routées 24h", value: recentRoutes },
    ],
    alerts: alerts.slice(0, 3),
    topServices: ranked.slice(0, 3),
  };
}

const ICONS = [
  "solar:target-linear",
  "solar:camera-linear",
  "solar:chart-linear",
];

export default async function HomePage() {
  const { metrics, alerts, topServices } = await loadData();

  return (
    <>
      <DashboardHeader />

      {/* === Pattern B — Hero === */}
      <section className="min-h-[80vh] w-full flex flex-col justify-end px-4 md:px-8 pb-12 pt-32 relative overflow-hidden">
        {/* Background video — globe in red wireframe */}
        <video
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 w-full h-full object-cover opacity-55 mix-blend-screen z-0"
          src="/planet-earth.mov"
        />
        {/* Fade to bg at top + bottom for content readability */}
        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-b from-[#030303] via-transparent to-[#030303]" />
        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-r from-[#030303]/60 via-transparent to-[#030303]/60" />

        <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-end relative z-10">
          <div className="lg:col-span-8 flex flex-col z-20">
            <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max">
              [ NŒUD: 01 | SYS: CONTROL | OPTIQUE: ACTIVE ]
            </div>
            <h1 className="brand font-display text-fluid-title uppercase tracking-tight text-white m-0">
              Routage<br />
              <span className="text-[#FF3300]">Contrôlé.</span>
            </h1>
          </div>
          <div className="lg:col-span-4 flex flex-col justify-end pb-4 z-20">
            <p className="font-mono text-xs text-[#666666] tracking-widest leading-relaxed mb-8 uppercase max-w-sm">
              MOTEUR DE ROUTAGE QUALITÉ AUTONOME. TESTE, SCORE ET ROUTE CHAQUE
              COMMANDE VERS LE MEILLEUR SERVICE EN TEMPS RÉEL.
            </p>
            <RunScoringButton />
          </div>
        </div>
      </section>

      <div className="w-full h-px bg-[#666666]/20" />

      {/* === Pattern C — Metrics === */}
      <section className="py-24 px-4 md:px-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-12 border-b border-[#666666]/20 pb-24">
          <div className="md:col-span-4 flex flex-col justify-between gap-8">
            <div className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ MÉTRIQUES: LIVE | FENÊTRE: 24H ]
            </div>
            <h2
              className="brand font-display tracking-tight uppercase leading-none text-white"
              style={{ fontSize: "clamp(2rem, 4vw, 3.5rem)" }}
            >
              Métriques<br />Opérationnelles.
            </h2>
          </div>
          <div className="md:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12 pt-12 md:pt-0">
            {metrics.map((m) => (
              <div key={m.num} className="flex flex-col gap-4">
                <div className="h-px w-full bg-[#666666]/30" />
                <h3 className="font-mono text-xs tracking-widest text-[#666666] uppercase">
                  {m.num}. {m.label}
                </h3>
                <div className="brand font-display text-5xl md:text-6xl tabular-nums text-white">
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* === Pattern D — Top services === */}
      <section className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
          [ TOP PERFORMERS | CLASSÉS PAR SCORE ]
        </div>
        {topServices.length === 0 ? (
          <div className="px-8 py-24 text-center font-mono text-xs text-[#666666] tracking-widest uppercase border-b border-[#666666]/20">
            AUCUN SCORE CALCULÉ. LANCEZ LE PIPELINE DEPUIS{" "}
            <Link href="/config" className="text-[#FF3300] interactive">
              /CONFIG
            </Link>
            .
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 w-full border-b border-[#666666]/20">
            {topServices.map((s, i) => {
              const bg = i % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
              const hoverBg =
                i % 2 === 0 ? "hover:bg-[#0D0D0D]" : "hover:bg-[#030303]";
              const borderRight =
                i < topServices.length - 1
                  ? "md:border-r border-[#666666]/20"
                  : "";
              return (
                <Link
                  key={s.id}
                  href={`/services/${s.id}`}
                  className={`group relative p-8 md:p-12 ${borderRight} ${bg} ${hoverBg} transition-colors duration-500 interactive`}
                >
                  <div className="absolute top-8 right-8 text-[#666666] group-hover:text-[#FF3300] transition-colors">
                    <iconify-icon
                      icon={ICONS[i] ?? ICONS[0]}
                      width="24"
                      height="24"
                    />
                  </div>
                  <div className="mt-16 flex flex-col gap-6">
                    <h4 className="brand font-display text-2xl tracking-tight uppercase text-white">
                      {s.name}
                    </h4>
                    <div className="font-mono text-xs text-[#666666] leading-relaxed uppercase">
                      [ {s.platform} / {s.serviceType} ]
                      <br />
                      SCORE :{" "}
                      <span className="text-[#FF3300]">
                        {s.score.toFixed(0)}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* === Pattern E — Alerts === */}
      <section className="px-4 md:px-8 py-24">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 p-8 md:p-12">
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ FLUX: ALERTES ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              MONITEUR_LIVE_01
            </span>
          </div>
          {alerts.length === 0 ? (
            <div className="py-12 text-center">
              <div className="brand font-display text-3xl md:text-5xl uppercase tracking-tight text-white">
                [ TOUS SYSTÈMES NOMINAL ]
              </div>
              <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-4">
                AUCUNE DÉGRADATION DÉTECTÉE SUR LES 48 DERNIÈRES HEURES.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-6">
                [ DÉGRADATIONS DÉTECTÉES — 48H ]
              </div>
              {alerts.map((a) => (
                <Link
                  key={a.serviceId}
                  href={`/services/${a.serviceId}`}
                  className="block border-l-2 border-[#FF3300] pl-4 py-2 font-mono text-xs uppercase tracking-widest text-[#666666] hover:text-white transition-colors interactive"
                >
                  <span className="text-[#FF3300]">[ ALERTE ]</span>{" "}
                  <span className="text-white">{a.name}</span> — DÉGRADATION
                  SCORE{" "}
                  <span className="text-[#FF3300]">
                    {a.diff.toFixed(0)}PT/48H
                  </span>{" "}
                  ({a.oldScore.toFixed(0)} → {a.latestScore.toFixed(0)})
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* === Pattern F — CTA === */}
      <section
        data-cursor="invert"
        className="w-full bg-[#FF3300] py-24 px-4 md:px-8 text-black flex flex-col items-center justify-center text-center"
      >
        <div className="font-mono text-xs tracking-widest mb-8 border border-black/30 px-4 py-1">
          [ DÉCLENCHEMENT MANUEL ]
        </div>
        <h2 className="brand font-display text-fluid-title uppercase tracking-tight leading-none mb-12 hover:tracking-normal transition-all duration-700 interactive">
          Exécuter.
        </h2>
        <SyncServicesButton />
      </section>
    </>
  );
}
