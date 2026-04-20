import { DashboardHeader } from "@/components/DashboardHeader";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";
import { PoolStatsHero } from "./PoolStatsHero";
import { PoolHistoryChart } from "./PoolHistoryChart";

export const dynamic = "force-dynamic";

export default async function PoolPage() {
  const [stats, history] = await Promise.all([
    getPoolStats(),
    getPoolHistory30d(),
  ]);

  return (
    <>
      <DashboardHeader />

      {/* === Section 1 — Hero (Pattern B) === */}
      <PoolStatsHero initialStats={stats} />

      {/* === Section 2 — Graph (Pattern E) === */}
      <PoolHistoryChart initialData={history} />
    </>
  );
}
