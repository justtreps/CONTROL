import { DashboardHeader } from "@/components/DashboardHeader";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";
import { getPoolConfig } from "@/lib/pool/config";
import { PoolStatsHero } from "./PoolStatsHero";
import { PoolHistoryChart } from "./PoolHistoryChart";
import { PoolControls } from "./PoolControls";
import { PoolActiveJobs } from "./PoolActiveJobs";
import { PoolAccountsList } from "./PoolAccountsList";
import { PoolToastProvider } from "./PoolToast";

export const dynamic = "force-dynamic";

export default async function PoolPage() {
  const [stats, history, config] = await Promise.all([
    getPoolStats(),
    getPoolHistory30d(),
    getPoolConfig(),
  ]);

  return (
    <PoolToastProvider>
      <DashboardHeader />

      {/* === Section 1 — Hero (Pattern B) === */}
      <PoolStatsHero initialStats={stats} />

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
    </PoolToastProvider>
  );
}
