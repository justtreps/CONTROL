import { Nav } from "@/components/Nav";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [serviceCount, activeServiceCount, testAccountCount, testOrderCount] =
    await Promise.all([
      prisma.service.count(),
      prisma.service.count({ where: { active: true } }),
      prisma.testAccount.count({ where: { active: true } }),
      prisma.testOrder.count(),
    ]);

  const metrics = [
    { label: "Services totaux", value: serviceCount },
    { label: "Services actifs", value: activeServiceCount },
    { label: "Comptes test actifs", value: testAccountCount },
    { label: "Test orders placées", value: testOrderCount },
  ];

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="brand text-3xl mb-8">Dashboard</h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="bg-white border border-neutral-200 rounded-lg p-5"
            >
              <div className="text-sm text-neutral-500">{m.label}</div>
              <div className="text-3xl font-semibold mt-1">{m.value}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-neutral-200 rounded-lg p-6">
          <h2 className="font-medium mb-2">Phase 1 — fondations en place</h2>
          <p className="text-sm text-neutral-600">
            Next.js + Prisma + auth + client BulkMedya initialisés. Ajoute tes
            clés API sur{" "}
            <a href="/config" className="underline">
              /config
            </a>{" "}
            puis clique sur « Sync services » pour récupérer la liste BulkMedya.
          </p>
        </div>
      </main>
    </>
  );
}
