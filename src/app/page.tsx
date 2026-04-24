// Root dashboard — live observability landing. Server pre-renders
// the first payload from /api/dashboard/stats so first paint is
// immediate; the client takes over polling every 10 s afterwards.

import { DashboardHeader } from "@/components/DashboardHeader";
import { DashboardClient } from "./DashboardClient";

export const dynamic = "force-dynamic";

type StatsPayload = Awaited<ReturnType<typeof fetchInitialStats>>;

async function fetchInitialStats() {
  // Direct lib import for SSR — avoids an internal fetch hop.
  const { GET } = await import("./api/dashboard/stats/route");
  const res = await GET();
  return (await res.json()) as unknown as Record<string, unknown>;
}

export default async function DashboardPage() {
  let initial: StatsPayload | null = null;
  try {
    initial = await fetchInitialStats();
  } catch {
    initial = null;
  }

  return (
    <>
      <DashboardHeader />
      <DashboardClient initialStats={initial} />
    </>
  );
}
