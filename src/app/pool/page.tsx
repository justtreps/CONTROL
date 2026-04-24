import { DashboardHeader } from "@/components/DashboardHeader";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";
import { getPoolConfig } from "@/lib/pool/config";
import { getSystemToggles } from "@/lib/system/toggles";
import { PoolStatsHero } from "./PoolStatsHero";
import { PoolHistoryChart } from "./PoolHistoryChart";
import { PoolUnifiedActions } from "./PoolUnifiedActions";
import { PoolActiveJobs } from "./PoolActiveJobs";
import { PoolAccountsList } from "./PoolAccountsList";
import { PoolPostsList } from "./PoolPostsList";
import { PoolAdvancedConfig } from "./PoolAdvancedConfig";
import { SystemKillSwitch } from "./SystemKillSwitch";
import { PoolToastProvider } from "./PoolToast";
import { PoolUniverseSwitch, type ActivePool } from "./PoolUniverseSwitch";

export const dynamic = "force-dynamic";

function resolveActivePool(raw: string | undefined): ActivePool {
  return raw === "engagement" ? "engagement" : "follower";
}

export default async function PoolPage({
  searchParams,
}: {
  searchParams: { type?: string };
}) {
  const activePool = resolveActivePool(searchParams?.type);

  const [stats, history, config, toggles] = await Promise.all([
    getPoolStats(),
    getPoolHistory30d(activePool),
    getPoolConfig(),
    getSystemToggles(),
  ]);

  // Counts / targets driving the two top buttons. For the target we
  // reuse refillTarget* (follower pool) and engagementPoolTarget*
  // (engagement pool) summed across platforms — one single number
  // per universe is what the user can glance at.
  const followerCount =
    stats.followerPool.instagram.available +
    stats.followerPool.instagram.assigned +
    stats.followerPool.tiktok.available +
    stats.followerPool.tiktok.assigned;
  const followerTarget =
    config.refillTargetInstagram + config.refillTargetTiktok;
  const engagementCount =
    stats.engagementPool.instagram.available +
    stats.engagementPool.instagram.assigned +
    stats.engagementPool.tiktok.available +
    stats.engagementPool.tiktok.assigned;
  const engagementTarget =
    config.engagementPoolTargetInstagram + config.engagementPoolTargetTiktok;

  return (
    <PoolToastProvider>
      <DashboardHeader />

      {/* === Top universe switch — dominant structural element === */}
      <PoolUniverseSwitch
        activePool={activePool}
        followerCount={followerCount}
        followerTarget={followerTarget}
        engagementCount={engagementCount}
        engagementTarget={engagementTarget}
      />

      {/* === The rest re-mounts on pool change so we get a clean
          fade. All below is scoped to `activePool`; the kill switch
          + seeds + jobs history stay in the universe-agnostic block
          further down. === */}
      <div
        key={activePool}
        className="w-full animate-[fadeIn_180ms_ease-out]"
      >
        {/* Hero — scoped stats for the active pool */}
        <PoolStatsHero initialStats={stats} activePool={activePool} />

        {/* Kill Switch is global (covers both pools) — keep shared */}
        <SystemKillSwitch
          initialToggles={{
            poolScrapeEnabled: toggles.poolScrapeEnabled,
            poolHealthcheckEnabled: toggles.poolHealthcheckEnabled,
            routingApiEnabled: toggles.routingApiEnabled,
            testBotEnabled: toggles.testBotEnabled,
            scoringEngineEnabled: toggles.scoringEngineEnabled,
            workflowExecutorEnabled: toggles.workflowExecutorEnabled,
            dailyRetestEnabled: toggles.dailyRetestEnabled,
            autoKillDeadServicesEnabled: toggles.autoKillDeadServicesEnabled,
            dailySyncEnabled: toggles.dailySyncEnabled,
            dryRunMode: toggles.dryRunMode,
          }}
        />

        {/* === ZONE 1 — VUE D'ENSEMBLE === */}
        <ZoneHeader
          step="ZONE 1"
          title="VUE D'ENSEMBLE"
          hint="l'état de la réserve en un coup d'œil"
        />
        <Onboarding activePool={activePool} />
        <PoolHistoryChart initialData={history} activePool={activePool} />

        {/* === ZONE 2 — ACTIONS (scoped to activePool) === */}
        <ZoneHeader
          step="ZONE 2"
          title="ACTIONS"
          hint={`ce que tu peux lancer sur le pool ${activePool === "follower" ? "abonnés" : "engagement"}`}
        />
        <PoolUnifiedActions
          activePool={activePool}
          initialConfig={{
            autoRefillEnabled: config.autoRefillEnabled,
            refillThresholdInstagram: config.refillThresholdInstagram,
            refillTargetInstagram: config.refillTargetInstagram,
            refillThresholdTiktok: config.refillThresholdTiktok,
            refillTargetTiktok: config.refillTargetTiktok,
          }}
        />
        {/* Active jobs render below actions — they show every in-flight
            job regardless of pool, labelled with the pool they ran on. */}
        <PoolActiveJobs />

        {/* === ZONE 3 — COMPTES OU POSTS (selon l'univers actif) === */}
        <ZoneHeader
          step="ZONE 3"
          title={activePool === "follower" ? "COMPTES" : "POSTS"}
          hint={
            activePool === "follower"
              ? "recherche, filtre, inspection compte par compte"
              : "recherche, filtre, inspection post par post"
          }
        />
        {activePool === "follower" ? (
          <PoolAccountsList activePool={activePool} />
        ) : (
          <PoolPostsList />
        )}

        {/* === ZONE 4 — CONFIGURATION AVANCÉE === */}
        <ZoneHeader
          step="ZONE 4"
          title="CONFIGURATION AVANCÉE"
          hint="à laisser fermé en usage normal"
        />
        <PoolAdvancedConfig
          activePool={activePool}
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
            engagementPoolEnabled: config.engagementPoolEnabled,
            engagementPoolTargetInstagram: config.engagementPoolTargetInstagram,
            engagementPoolTargetTiktok: config.engagementPoolTargetTiktok,
            engagementPostsMin: config.engagementPostsMin,
            engagementLikesMaxPerPost: config.engagementLikesMaxPerPost,
            engagementFreshnessMaxDays: config.engagementFreshnessMaxDays,
            servicesSyncFrequencyHours: config.servicesSyncFrequencyHours,
            lastServicesSyncAt:
              config.lastServicesSyncAt?.toISOString() ?? null,
            lastServicesSyncResult: config.lastServicesSyncResult as
              | Record<string, number>
              | null,
            servicesSyncStartedAt:
              config.servicesSyncStartedAt?.toISOString() ?? null,
          }}
        />
      </div>
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

function Onboarding({ activePool }: { activePool: ActivePool }) {
  return (
    <div className="w-full px-4 md:px-8 pb-6">
      <div className="max-w-7xl mx-auto border-l-2 border-[#FF3300] pl-4 md:pl-5 py-2">
        {activePool === "follower" ? (
          <>
            <p className="font-mono text-[12px] md:text-[13px] text-[#CCCCCC] tracking-wide normal-case leading-relaxed">
              &gt; Les <span className="text-white">comptes abonnés</span> sont
              des comptes vierges (0 follower, 0 post) qu&apos;on utilise pour
              valider la qualité des services BulkMedya de type{" "}
              <span className="text-white">followers / abonnés</span>. On envoie
              quelques followers sur un compte, on mesure ce qui arrive
              réellement, on en déduit un score.
            </p>
            <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case leading-relaxed mt-2">
              Cette vue gère la réserve abonnés : combien de comptes on a en
              stock, on en scrape de nouveaux, on vérifie que les anciens sont
              toujours vierges.
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-[12px] md:text-[13px] text-[#CCCCCC] tracking-wide normal-case leading-relaxed">
              &gt; Les <span className="text-white">comptes engagement</span>{" "}
              sont des comptes qui ont au moins un post récent avec peu de
              likes naturels. On les utilise pour tester les services{" "}
              <span className="text-white">
                likes / vues / partages / enregistrements
              </span>{" "}
              : on envoie quelques likes sur un post du compte, on mesure la
              livraison, on score.
            </p>
            <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case leading-relaxed mt-2">
              Cette vue gère la réserve engagement. Le scrape et la
              vérification ciblent uniquement ce pool.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
