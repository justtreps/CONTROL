import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Alert = {
  serviceId: number;
  serviceName: string;
  platform: string;
  latestScore: number;
  oldScore: number;
  diff: number;
};

type TopService = {
  id: number;
  name: string;
  score: number;
};

async function loadData() {
  const now = Date.now();
  const last24h = new Date(now - 24 * 3600 * 1000);
  const last48h = new Date(now - 48 * 3600 * 1000);
  const last72h = new Date(now - 72 * 3600 * 1000);

  const [activeServices, testAccountsCount, recentTestOrders, recentRoutes] =
    await Promise.all([
      prisma.service.count({ where: { active: true } }),
      prisma.testAccount.count({ where: { active: true } }),
      prisma.testOrder.count({ where: { placedAt: { gte: last24h } } }),
      prisma.routingDecision.count({ where: { decidedAt: { gte: last24h } } }),
    ]);

  const services = await prisma.service.findMany({
    where: { active: true },
    include: {
      scores: {
        where: { computedAt: { gte: last72h } },
        orderBy: { computedAt: "asc" },
      },
    },
  });

  const alerts: Alert[] = [];
  const topByPlatform = new Map<string, TopService[]>();

  for (const s of services) {
    const scores = s.scores;
    const latest = scores[scores.length - 1];

    if (latest) {
      const arr = topByPlatform.get(s.platform) ?? [];
      arr.push({ id: s.id, name: s.name, score: latest.currentScore });
      topByPlatform.set(s.platform, arr);
    }

    if (scores.length < 2) continue;
    const target = now - 48 * 3600 * 1000;
    const old = scores.reduce((best, sc) =>
      Math.abs(sc.computedAt.getTime() - target) <
      Math.abs(best.computedAt.getTime() - target)
        ? sc
        : best
    );
    const diff = latest.currentScore - old.currentScore;
    if (diff <= -15 && old.computedAt < last48h) {
      alerts.push({
        serviceId: s.id,
        serviceName: s.name,
        platform: s.platform,
        latestScore: latest.currentScore,
        oldScore: old.currentScore,
        diff,
      });
    }
  }

  alerts.sort((a, b) => a.diff - b.diff);

  const topServicesEntries = Array.from(topByPlatform.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, arr]) => ({
      platform,
      top: arr.sort((a, b) => b.score - a.score).slice(0, 5),
    }));

  return {
    metrics: [
      { label: "Services actifs", value: activeServices },
      { label: "Comptes test actifs", value: testAccountsCount },
      { label: "Test orders 24h", value: recentTestOrders },
      { label: "Commandes routées 24h", value: recentRoutes },
    ],
    alerts,
    topServicesEntries,
  };
}

export default async function Home() {
  const { metrics, alerts, topServicesEntries } = await loadData();

  return (
    <>
      <DashboardHeader />
      <main className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="brand text-3xl mb-8">Dashboard</h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="bg-white border border-neutral-200 rounded-lg p-5"
            >
              <div className="text-sm text-neutral-500">{m.label}</div>
              <div className="text-3xl font-semibold mt-1 tabular-nums">
                {m.value}
              </div>
            </div>
          ))}
        </div>

        {alerts.length > 0 && (
          <section className="mb-10">
            <h2 className="font-medium text-sm uppercase tracking-wide text-neutral-500 mb-3">
              Alertes — services en chute ({alerts.length})
            </h2>
            <div className="bg-white border border-red-200 rounded-lg divide-y divide-red-100">
              {alerts.map((a) => (
                <Link
                  key={a.serviceId}
                  href={`/services/${a.serviceId}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-red-50"
                >
                  <div>
                    <div className="font-medium text-sm">{a.serviceName}</div>
                    <div className="text-xs text-neutral-500">{a.platform}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-neutral-500 tabular-nums">
                      {a.oldScore.toFixed(0)} → {a.latestScore.toFixed(0)}
                    </span>
                    <span className="text-sm font-medium text-red-700 tabular-nums">
                      {a.diff.toFixed(0)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="font-medium text-sm uppercase tracking-wide text-neutral-500 mb-3">
            Top services par plateforme
          </h2>
          {topServicesEntries.length === 0 ? (
            <div className="bg-white border border-neutral-200 rounded-lg p-6 text-sm text-neutral-500">
              Aucun score encore calculé. Lance le test bot + scraper + scoring
              depuis <Link href="/config" className="underline">/config</Link>.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {topServicesEntries.map((entry) => (
                <div
                  key={entry.platform}
                  className="bg-white border border-neutral-200 rounded-lg p-4"
                >
                  <div className="text-xs font-medium text-neutral-500 uppercase mb-2">
                    {entry.platform}
                  </div>
                  <ul className="divide-y divide-neutral-100">
                    {entry.top.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/services/${s.id}`}
                          className="flex items-center justify-between py-2 text-sm hover:bg-neutral-50 -mx-1 px-1 rounded"
                        >
                          <span className="truncate pr-3">{s.name}</span>
                          <ScoreBadge score={s.score} size="sm" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
