// Centralised alerts surface. Polls /api/alerts every 10s and
// renders rows sorted by severity DESC then lastTriggeredAt DESC.
// Server-rendered initial payload so first paint already shows the
// live state without a pre-flight fetch.

import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { AlertsList } from "./AlertsList";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const alerts = await prisma.alert.findMany({
    where: { status: { in: ["active", "acknowledged"] } },
    orderBy: [{ severity: "desc" }, { lastTriggeredAt: "desc" }],
    take: 200,
  });
  const [crit, warn, info, ack, resolved] = await Promise.all([
    prisma.alert.count({
      where: { status: "active", severity: "critical" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "warning" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "info" },
    }),
    prisma.alert.count({ where: { status: "acknowledged" } }),
    prisma.alert.count({
      where: { status: { in: ["resolved", "auto_resolved"] } },
    }),
  ]);

  return (
    <>
      <DashboardHeader />
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-8">
        <div className="max-w-7xl mx-auto flex flex-col gap-4">
          <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
            [ OBSERVABILITÉ · DÉTECTEUR */2min ]
          </div>
          <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
            Alertes.
          </h1>
          <p className="font-mono text-xs text-[#666666] normal-case leading-relaxed max-w-3xl">
            Le système scanne 16 conditions toutes les 2 min et crée /
            résout les alertes automatiquement. Chaque alerte explique
            pourquoi elle fire, l&apos;impact, et propose une action concrète.
          </p>
        </div>
      </section>

      <AlertsList
        initial={alerts.map((a) => ({
          ...a,
          firstTriggeredAt: a.firstTriggeredAt.toISOString(),
          lastTriggeredAt: a.lastTriggeredAt.toISOString(),
          resolvedAt: a.resolvedAt?.toISOString() ?? null,
          acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        }))}
        counts={{ crit, warn, info, ack, resolved }}
      />
    </>
  );
}
