import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { ServicesTable, type ServiceRow } from "./ServicesTable";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const services = await prisma.service.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      scores: {
        orderBy: { computedAt: "desc" },
        take: 30,
      },
      _count: { select: { testOrders: true } },
    },
  });

  const rows: ServiceRow[] = services.map((s) => {
    const latest = s.scores[0] ?? null;
    const history = [...s.scores].reverse().slice(-30).map((sc) => sc.currentScore);
    return {
      id: s.id,
      name: s.name,
      category: s.category,
      platform: s.platform,
      serviceType: s.serviceType,
      ratePerK: s.ratePerK,
      minQuantity: s.minQuantity,
      maxQuantity: s.maxQuantity,
      refillSupported: s.refillSupported,
      testOrderCount: s._count.testOrders,
      currentScore: latest?.currentScore ?? null,
      completionFactor: latest?.completionFactor ?? null,
      realismScore: latest?.realismScore ?? null,
      speedScore: latest?.speedScore ?? null,
      dropScore: latest?.dropScore ?? null,
      history,
    };
  });

  return (
    <>
      <DashboardHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="brand text-3xl">Services</h1>
          <p className="text-sm text-neutral-500">
            {services.length} services actifs
          </p>
        </div>
        <ServicesTable rows={rows} />
      </main>
    </>
  );
}
