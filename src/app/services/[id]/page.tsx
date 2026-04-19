import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import { ServiceDetailCharts, type ScorePoint } from "./ServiceDetailCharts";

export const dynamic = "force-dynamic";

export default async function ServiceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return notFound();

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const service = await prisma.service.findUnique({
    where: { id },
    include: {
      scores: {
        where: { computedAt: { gte: since } },
        orderBy: { computedAt: "asc" },
      },
      testOrders: {
        orderBy: { placedAt: "desc" },
        take: 20,
        include: {
          testAccount: true,
          measurements: { orderBy: { checkedAt: "asc" } },
        },
      },
    },
  });

  if (!service) return notFound();

  const latest = service.scores[service.scores.length - 1] ?? null;

  const scorePoints: ScorePoint[] = service.scores.map((s) => ({
    t: s.computedAt.toISOString(),
    total: round1(s.currentScore),
    completion: round1(s.completionFactor * 100),
    realism: round1(s.realismScore),
    speed: round1(s.speedScore),
    drop: round1(s.dropScore),
  }));

  const orderRows = service.testOrders.map((o) => {
    const sortedM = o.measurements;
    const latestM = sortedM[sortedM.length - 1];
    const peak = sortedM.length > 0 ? Math.max(...sortedM.map((m) => m.actualCount)) : o.baselineCount;
    const delivered = Math.max(0, peak - o.baselineCount);
    const deliveredPct = Math.min(
      100,
      (delivered / Math.max(1, o.targetQuantity)) * 100
    );
    return {
      id: o.id,
      placedAt: o.placedAt,
      account: `@${o.testAccount.username}`,
      quantity: o.targetQuantity,
      baselineCount: o.baselineCount,
      latestCount: latestM?.actualCount ?? o.baselineCount,
      latestCheckpoint: latestM?.checkpoint ?? "—",
      deliveredPct,
      bulkmedyaOrderId: o.bulkmedyaOrderId,
    };
  });

  return (
    <>
      <DashboardHeader />
      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <Link
            href="/services"
            className="text-sm text-neutral-500 hover:text-neutral-900"
          >
← Tous les services
          </Link>
          <h1 className="brand text-2xl mt-2">{service.name}</h1>
          <div className="flex flex-wrap gap-2 items-center text-xs text-neutral-500 mt-1">
            <span className="bg-neutral-100 px-2 py-0.5 rounded">
              {service.platform}
            </span>
            <span className="bg-neutral-100 px-2 py-0.5 rounded">
              {service.serviceType}
            </span>
            <span>ID BulkMedya {service.bulkmedyaId}</span>
            <span>·</span>
            <span>tarif {service.ratePerK.toFixed(2)}/k</span>
            <span>·</span>
            <span>
              min {service.minQuantity} / max {service.maxQuantity}
            </span>
            {service.refillSupported && (
              <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded">
                refill
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <ScoreCard label="Score total" score={latest?.currentScore ?? null} primary />
          <ScoreCard
            label="Livraison"
            score={latest ? latest.completionFactor * 100 : null}
          />
          <ScoreCard label="Réalisme" score={latest?.realismScore ?? null} />
          <ScoreCard label="Vitesse" score={latest?.speedScore ?? null} />
          <ScoreCard label="Drop" score={latest?.dropScore ?? null} />
        </div>

        <section className="mb-10">
          <h2 className="font-medium text-sm uppercase tracking-wide text-neutral-500 mb-3">
            Évolution 30 jours
          </h2>
          <div className="bg-white border border-neutral-200 rounded-lg p-4">
            {scorePoints.length < 2 ? (
              <p className="text-sm text-neutral-500 py-10 text-center">
                Pas encore assez de données ({scorePoints.length} point
                {scorePoints.length === 1 ? "" : "s"}). Le moteur de scoring
                écrira des points au fil du temps.
              </p>
            ) : (
              <ServiceDetailCharts points={scorePoints} />
            )}
          </div>
        </section>

        <section>
          <h2 className="font-medium text-sm uppercase tracking-wide text-neutral-500 mb-3">
            Commandes test récentes ({orderRows.length})
          </h2>
          {orderRows.length === 0 ? (
            <div className="bg-white border border-neutral-200 rounded-lg p-6 text-sm text-neutral-500">
              Aucune commande test pour ce service.
            </div>
          ) : (
            <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-xs uppercase text-neutral-600">
                  <tr>
                    <th className="text-left px-4 py-3">Placée</th>
                    <th className="text-left px-3 py-3">Compte</th>
                    <th className="text-right px-3 py-3">Cible</th>
                    <th className="text-right px-3 py-3">Référence</th>
                    <th className="text-right px-3 py-3">Dernier</th>
                    <th className="text-right px-3 py-3">Livré</th>
                    <th className="text-left px-3 py-3">Checkpoint</th>
                    <th className="text-left px-3 py-3">ID BM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {orderRows.map((o) => (
                    <tr key={o.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2.5 whitespace-nowrap text-neutral-600">
                        {o.placedAt.toISOString().replace("T", " ").slice(0, 16)}
                      </td>
                      <td className="px-3 py-2.5">{o.account}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {o.quantity}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                        {o.baselineCount}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {o.latestCount}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <ScoreBadge score={o.deliveredPct} size="sm" />
                      </td>
                      <td className="px-3 py-2.5 text-neutral-600">
                        {o.latestCheckpoint}
                      </td>
                      <td className="px-3 py-2.5 text-neutral-500 font-mono text-xs">
                        {o.bulkmedyaOrderId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ScoreCard({
  label,
  score,
  primary,
}: {
  label: string;
  score: number | null;
  primary?: boolean;
}) {
  return (
    <div
      className={`bg-white border border-neutral-200 rounded-lg p-4 ${
        primary ? "md:col-span-1" : ""
      }`}
    >
      <div className="text-xs text-neutral-500 mb-2">{label}</div>
      <div className={primary ? "text-2xl font-semibold" : "text-lg"}>
        <ScoreBadge score={score} />
      </div>
    </div>
  );
}
