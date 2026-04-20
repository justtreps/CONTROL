import { DashboardHeader } from "@/components/DashboardHeader";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";
import { getPoolConfig } from "@/lib/pool/config";
import { getSystemToggles } from "@/lib/system/toggles";
import { PoolStatsHero } from "./PoolStatsHero";
import { PoolHistoryChart } from "./PoolHistoryChart";
import { PoolControls } from "./PoolControls";
import { PoolActiveJobs } from "./PoolActiveJobs";
import { PoolAccountsList } from "./PoolAccountsList";
import { PoolSettings } from "./PoolSettings";
import { PoolSeedsCard } from "./PoolSeedsCard";
import { PoolPrefixesCard } from "./PoolPrefixesCard";
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

      {/* === Section 1 — Hero (Pattern B) === */}
      <PoolStatsHero initialStats={stats} />

      {/* === Section 1.5 — Kill Switch === */}
      <SystemKillSwitch
        initialToggles={{
          poolScrapeEnabled: toggles.poolScrapeEnabled,
          poolHealthcheckEnabled: toggles.poolHealthcheckEnabled,
          routingApiEnabled: toggles.routingApiEnabled,
          testBotEnabled: toggles.testBotEnabled,
          scoringEngineEnabled: toggles.scoringEngineEnabled,
        }}
      />

      {/* === Section 2 — Graph (Pattern E) === */}
      <PoolHistoryChart initialData={history} />

      {/* === Section 3 — Manual controls (Pattern D) === */}
      <PoolControls
        initialConfig={{
          autoRefillEnabled: config.autoRefillEnabled,
          refillThresholdInstagram: config.refillThresholdInstagram,
          refillTargetInstagram: config.refillTargetInstagram,
          refillThresholdTiktok: config.refillThresholdTiktok,
          refillTargetTiktok: config.refillTargetTiktok,
        }}
      />

      {/* === Section 4 — Active jobs (5s polling, conditional render) === */}
      <PoolActiveJobs />

      {/* === Section 5 — Accounts list === */}
      <PoolAccountsList />

      {/* === Section 7 — Settings (Pattern D, 4 sub-cards) === */}
      <PoolSettings
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
          healthCheckEnabled: config.healthCheckEnabled,
          healthCheckCron: config.healthCheckCron,
          maxFollowerCount: config.maxFollowerCount,
          maxFollowingCount: config.maxFollowingCount,
          requireNotPrivate: config.requireNotPrivate,
          invalidateIfFollowerAbove: config.invalidateIfFollowerAbove,
        }}
      />

      {/* === Section 8a — Seeds (2 cols: active + suggestions) === */}
      <PoolSeedsCard />

      {/* === Section 8b — Prefixes (chips) === */}
      <PoolPrefixesCard />
    </PoolToastProvider>
  );
}
