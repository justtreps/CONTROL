import { DashboardHeader } from "@/components/DashboardHeader";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";
import { getPoolConfig } from "@/lib/pool/config";
import { getSystemToggles } from "@/lib/system/toggles";
import { PoolStatsHero } from "./PoolStatsHero";
import { PoolHistoryChart } from "./PoolHistoryChart";
import { PoolUnifiedActions } from "./PoolUnifiedActions";
import { PoolActiveJobs } from "./PoolActiveJobs";
import { PoolAccountsList } from "./PoolAccountsList";
import { PoolAdvancedConfig } from "./PoolAdvancedConfig";
import { SystemKillSwitch } from "./SystemKillSwitch";
import { PoolToastProvider } from "./PoolToast";

export const dynamic = "force-dynamic";

export default async function PoolPage() {
  const [stats, history, config, toggles] = await Promise.all([
    getPoolStats(),
    getPoolHistory30d(),
    getPoolConfig(),
    getSystemToggles(),
  ]);

  return (
    <PoolToastProvider>
      <DashboardHeader />

      {/* === Hero — headline + live IG/TT breakdown === */}
      <PoolStatsHero initialStats={stats} />

      {/* === Kill Switch (system control) === */}
      <SystemKillSwitch
        initialToggles={{
          poolScrapeEnabled: toggles.poolScrapeEnabled,
          poolHealthcheckEnabled: toggles.poolHealthcheckEnabled,
          routingApiEnabled: toggles.routingApiEnabled,
          testBotEnabled: toggles.testBotEnabled,
          scoringEngineEnabled: toggles.scoringEngineEnabled,
        }}
      />

      {/* === ZONE 1 — VUE D'ENSEMBLE === */}
      <ZoneHeader
        step="ZONE 1"
        title="VUE D'ENSEMBLE"
        hint="l'état de la réserve en un coup d'œil"
      />
      <Onboarding />
      <PoolHistoryChart initialData={history} />

      {/* === ZONE 2 — ACTIONS === */}
      <ZoneHeader
        step="ZONE 2"
        title="ACTIONS"
        hint="ce que tu peux lancer manuellement"
      />
      <PoolUnifiedActions
        initialConfig={{
          autoRefillEnabled: config.autoRefillEnabled,
          refillThresholdInstagram: config.refillThresholdInstagram,
          refillTargetInstagram: config.refillTargetInstagram,
          refillThresholdTiktok: config.refillThresholdTiktok,
          refillTargetTiktok: config.refillTargetTiktok,
        }}
      />
      {/* Only renders when at least one job is pending/running */}
      <PoolActiveJobs />

      {/* === ZONE 3 — COMPTES === */}
      <ZoneHeader
        step="ZONE 3"
        title="COMPTES"
        hint="recherche, filtre, inspection compte par compte"
      />
      <PoolAccountsList />

      {/* === ZONE 4 — CONFIGURATION AVANCÉE (collapsible) === */}
      <ZoneHeader
        step="ZONE 4"
        title="CONFIGURATION AVANCÉE"
        hint="à laisser fermé en usage normal"
      />
      <PoolAdvancedConfig
        initialConfig={{
          autoRefillEnabled: config.autoRefillEnabled,
          refillThresholdInstagram: config.refillThresholdInstagram,
          refillTargetInstagram: config.refillTargetInstagram,
          refillThresholdTiktok: config.refillThresholdTiktok,
          refillTargetTiktok: config.refillTargetTiktok,
          maxRapidapiCallsPerScrapeRun: config.maxRapidapiCallsPerScrapeRun,
          maxRapidapiCallsPerHealthcheck: config.maxRapidapiCallsPerHealthcheck,
          maxAttemptsMethodB: config.maxAttemptsMethodB,
          maxPagesPerSeed: config.maxPagesPerSeed,
          methodARatio: config.methodARatio,
          methodBEnabled: config.methodBEnabled,
          healthCheckEnabled: config.healthCheckEnabled,
          healthCheckCron: config.healthCheckCron,
          maxFollowerCount: config.maxFollowerCount,
          maxFollowerCountTiktok: config.maxFollowerCountTiktok,
          maxFollowingCount: config.maxFollowingCount,
          requireNotPrivate: config.requireNotPrivate,
        }}
      />
    </PoolToastProvider>
  );
}

function ZoneHeader({
  step,
  title,
  hint,
}: {
  step: string;
  title: string;
  hint: string;
}) {
  return (
    <div className="w-full px-4 md:px-8 pt-12 md:pt-16 pb-4">
      <div className="max-w-7xl mx-auto flex items-end gap-4 flex-wrap border-b border-[#FF3300]/60 pb-3">
        <span className="font-mono text-[11px] text-[#FF3300] tracking-widest">
          [ {step} ]
        </span>
        <h2 className="brand font-display text-3xl md:text-4xl uppercase tracking-tight text-white m-0 leading-none">
          {title}.
        </h2>
        <span className="ml-auto font-mono text-[10px] text-[#666666] tracking-wide normal-case">
          {hint}
        </span>
      </div>
    </div>
  );
}

function Onboarding() {
  return (
    <div className="w-full px-4 md:px-8 pb-6">
      <div className="max-w-7xl mx-auto border-l-2 border-[#FF3300] pl-4 md:pl-5 py-2">
        <p className="font-mono text-[12px] md:text-[13px] text-[#CCCCCC] tracking-wide normal-case leading-relaxed">
          &gt; Les <span className="text-white">comptes test</span> sont de faux
          comptes vierges (0 follower, 0 post) qu&apos;on utilise pour valider la
          qualité des services BulkMedya avant de les proposer aux clients. On
          envoie quelques followers/likes sur un compte test, on mesure ce qui
          arrive réellement, on en déduit un score.
        </p>
        <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case leading-relaxed mt-2">
          Cette page gère la réserve : combien de comptes test on a en stock, on
          en scrape de nouveaux, on vérifie que les anciens sont toujours
          vierges. En usage normal tu n&apos;as qu&apos;à regarder la{" "}
          <span className="text-[#FF3300]">ZONE 1</span> et lancer des actions
          depuis la <span className="text-[#FF3300]">ZONE 2</span>.
        </p>
      </div>
    </div>
  );
}
