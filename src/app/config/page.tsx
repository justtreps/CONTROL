import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { getConfig } from "@/lib/config";
import { isDryRun } from "@/lib/router";
import { ConfigForms } from "./ConfigForms";
import { ConfigDangerZone } from "./ConfigDangerZone";
import { RapidApiKeysCard } from "./RapidApiKeysCard";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const last24h = new Date(Date.now() - 24 * 3600 * 1000);

  const [bulkmedyaKey, rapidApiKey, testAccounts, serviceCount, ordersLast24] =
    await Promise.all([
      getConfig<string>("bulkmedya_api_key"),
      getConfig<string>("rapidapi_key"),
      prisma.testAccount.findMany({
        orderBy: [{ platform: "asc" }, { username: "asc" }],
      }),
      prisma.service.count(),
      prisma.routingDecision.count({
        where: { decidedAt: { gte: last24h } },
      }),
    ]);

  const dryRun = isDryRun();

  const statusLines: Array<{ label: string; value: string; ok: boolean | null }> = [
    {
      label: "BULKMEDYA",
      value: bulkmedyaKey ? "[ ✓ CONFIGURÉE ]" : "[ ✗ MANQUANTE ]",
      ok: Boolean(bulkmedyaKey),
    },
    {
      label: "RAPIDAPI",
      value: rapidApiKey ? "[ ✓ CONFIGURÉE ]" : "[ ✗ MANQUANTE ]",
      ok: Boolean(rapidApiKey),
    },
    {
      label: "SERVICES EN DB",
      value: String(serviceCount),
      ok: null,
    },
    {
      label: "COMPTES TEST",
      value: String(testAccounts.length),
      ok: null,
    },
    {
      label: "COMMANDES 24H",
      value: String(ordersLast24),
      ok: null,
    },
    {
      label: "DRY_RUN",
      value: dryRun ? "[ ACTIF ]" : "[ INACTIF — LIVE ]",
      ok: dryRun,
    },
    {
      label: "SCOPE",
      value: "[ INSTAGRAM FOLLOWERS + TIKTOK FOLLOWERS ]",
      ok: null,
    },
  ];

  return (
    <>
      <DashboardHeader />

      {/* === Pattern B — Hero === */}
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-12 md:pb-16">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-12 items-end">
          <div className="lg:col-span-7 flex flex-col min-w-0">
            <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max">
              [ NŒUD CONFIG | ACCÈS ADMIN ]
            </div>
            <h1
              className="brand font-display uppercase tracking-tight leading-[0.85] text-white m-0"
              style={{ fontSize: "clamp(3rem, 7.5vw, 6.5rem)" }}
            >
              Paramètres<br />
              <span className="text-[#FF3300]">Système.</span>
            </h1>
          </div>
          <div className="lg:col-span-5 flex flex-col font-mono text-xs uppercase tracking-widest min-w-0">
            {statusLines.map((s) => (
              <div
                key={s.label}
                className="flex items-center justify-between py-2 border-b border-[#666666]/20 last:border-b-0"
              >
                <span className="text-[#666666]">{s.label}</span>
                <span
                  className={
                    s.ok === true
                      ? "text-[#00FF88]"
                      : s.ok === false
                        ? "text-[#FF3300]"
                        : "text-white"
                  }
                >
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Flotte multi-clés RapidAPI — affichée en premier pour être la
          1re chose vue. L'ancien champ RAPIDAPI_KEY dans ConfigForms
          en dessous ne sert plus qu'au legacy seed fallback. */}
      <RapidApiKeysCard />

      <ConfigForms
        initialBulkmedyaSet={Boolean(bulkmedyaKey)}
        initialRapidApiSet={Boolean(rapidApiKey)}
        testAccounts={testAccounts.map((a) => ({
          id: a.id,
          platform: a.platform,
          username: a.username,
          userId: a.userId,
          active: a.active,
        }))}
      />

      <ConfigDangerZone />
    </>
  );
}
