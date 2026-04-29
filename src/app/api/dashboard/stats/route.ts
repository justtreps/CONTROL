// Aggregated payload for the root dashboard. Every field is a
// single DB query (or cheap aggregation). A short module-level
// cache absorbs the 10s polling load.
//
// Cache TTL was 30s — too long. Each Vercel function instance
// holds its own cache, so a stale snapshot could survive across
// multiple polls when traffic landed on a warm instance. After
// the scoring formula change, operators were seeing weighted
// scores 60s+ behind the DB. TTL is now 5s — still absorbs ~50%
// of the polling load (client polls every 10s) without retaining
// stale data long enough to confuse the ranking.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { getActiveCampaign } from "@/lib/scoring/campaign";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

type CachedPayload = { at: number; data: unknown };
let cache: CachedPayload | null = null;
const CACHE_TTL_MS = 5_000;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data, {
      headers: {
        "x-cache": "HIT",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }
  const data = await build();
  cache = { at: Date.now(), data };
  return NextResponse.json(data, {
    headers: {
      "x-cache": "MISS",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

async function build() {
  const now = new Date();
  const last24h = new Date(Date.now() - 24 * 3600 * 1000);
  const last7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // ── Global stats ─────────────────────────────────────────────
  const toggles = await getSystemToggles();

  const [
    running,
    completed7d,
    aborted7d,
    total7d,
    monthOrders,
    candidatesEligible,
    scoredCount,
    avgScoreAgg,
  ] = await Promise.all([
    prisma.testOrder.count({ where: { status: "running" } }),
    prisma.testOrder.count({
      where: { status: "completed", placedAt: { gte: last7d } },
    }),
    prisma.testOrder.count({
      where: {
        status: "aborted_target_died",
        placedAt: { gte: last7d },
      },
    }),
    prisma.testOrder.count({ where: { placedAt: { gte: last7d } } }),
    prisma.testOrder.findMany({
      where: {
        placedAt: { gte: startOfMonth },
        dryRun: false,
      },
      include: { service: { select: { ratePerK: true } } },
    }),
    prisma.productServiceCandidate.count({
      where: { isEligible: true, forceExcluded: false },
    }),
    prisma.productServiceCandidate.count({
      where: {
        isEligible: true,
        forceExcluded: false,
        currentScore: { not: null },
      },
    }),
    prisma.productServiceCandidate.aggregate({
      where: {
        isEligible: true,
        forceExcluded: false,
        currentScore: { not: null },
      },
      _avg: { currentScore: true },
    }),
  ]);

  const monthCost = monthOrders.reduce(
    (a, o) =>
      a + ((o.service?.ratePerK ?? 0) * o.targetQuantity) / 1000,
    0
  );
  const abortRate7d =
    total7d > 0 ? Math.round((aborted7d / total7d) * 1000) / 10 : 0;

  const globalStats = {
    testsRunning: running,
    completed7d,
    aborted7d,
    abortRate7d,
    monthCost: Math.round(monthCost * 100) / 100,
    monthOrderCount: monthOrders.length,
    servicesScored: scoredCount,
    servicesEligible: candidatesEligible,
    avgCatalogueScore:
      avgScoreAgg._avg.currentScore !== null
        ? Math.round((avgScoreAgg._avg.currentScore ?? 0) * 10) / 10
        : null,
    toggles: {
      testBotEnabled: toggles.testBotEnabled,
      scoringEngineEnabled: toggles.scoringEngineEnabled,
      dryRunMode: toggles.dryRunMode,
    },
  };

  // ── Tests per hour (last 24 h bucketed) ───────────────────────
  const recent = await prisma.testOrder.findMany({
    where: { placedAt: { gte: last24h } },
    select: { placedAt: true, status: true, dryRun: true },
  });
  const testsByHour = bucketPerHour(recent, last24h, now);

  // ── Status distribution (all-time running, 30d others) ────────
  const statusBuckets = await Promise.all([
    prisma.testOrder.count({ where: { status: "running" } }),
    prisma.testOrder.count({
      where: {
        status: "completed",
        placedAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    }),
    prisma.testOrder.count({
      where: {
        status: "aborted_target_died",
        placedAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    }),
    prisma.testOrder.count({
      where: {
        retryCount: { gt: 0 },
        placedAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    }),
  ]);
  const statusDistribution = [
    { label: "RUNNING", count: statusBuckets[0], color: "#00CC66" },
    { label: "COMPLETED", count: statusBuckets[1], color: "#66CCFF" },
    { label: "ABORTED", count: statusBuckets[2], color: "#FF3300" },
    { label: "RETRY", count: statusBuckets[3], color: "#FFCC00" },
  ];

  // ── Score distribution (histogram) ────────────────────────────
  const scoreRows = await prisma.productServiceCandidate.findMany({
    where: {
      isEligible: true,
      forceExcluded: false,
      currentScore: { not: null },
    },
    select: { currentScore: true },
  });
  const scoreDistribution = [
    { label: "0-20", count: 0, color: "#FF3300" },
    { label: "20-40", count: 0, color: "#FF6633" },
    { label: "40-60", count: 0, color: "#FFCC00" },
    { label: "60-80", count: 0, color: "#99CC33" },
    { label: "80-100", count: 0, color: "#00CC66" },
  ];
  for (const r of scoreRows) {
    const s = r.currentScore ?? 0;
    const idx = Math.min(4, Math.max(0, Math.floor(s / 20)));
    scoreDistribution[idx].count++;
  }

  // ── RapidAPI usage (per-key current snapshot) ─────────────────
  // We don't carry historical per-key usage timeseries. V1 returns
  // the current cumulative quotaUsed vs quotaMonthly per key so the
  // UI can render a row of progress bars. A proper 24 h multi-line
  // chart needs a new usage-snapshot table, deferred.
  const keys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram" },
    orderBy: { id: "asc" },
  });
  const rapidApiUsage = keys.map((k) => ({
    id: k.id,
    label: k.label,
    status: k.status,
    quotaUsed: k.quotaUsed,
    quotaMonthly: k.quotaMonthly,
    ratio:
      k.quotaMonthly && k.quotaMonthly > 0
        ? Math.round((k.quotaUsed / k.quotaMonthly) * 1000) / 10
        : null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  }));

  // ── Product breakdown ─────────────────────────────────────────
  const products = await prisma.myBoostProduct.findMany({
    where: { isActive: true },
    orderBy: [{ platform: "asc" }, { productType: "asc" }],
  });
  const productBreakdown = await Promise.all(
    products.map(async (p) => {
      const [total, eligible, recentCount, top5] = await Promise.all([
        prisma.productServiceCandidate.count({
          where: { productId: p.id },
        }),
        prisma.productServiceCandidate.count({
          where: {
            productId: p.id,
            isEligible: true,
            forceExcluded: false,
          },
        }),
        prisma.productServiceCandidate.count({
          where: {
            productId: p.id,
            isEligible: true,
            forceExcluded: false,
            lastScoredAt: { gte: last7d },
          },
        }),
        prisma.productServiceCandidate.findMany({
          where: {
            productId: p.id,
            isEligible: true,
            forceExcluded: false,
            currentScore: { not: null },
          },
          orderBy: [{ rank: { sort: "asc", nulls: "last" } }],
          take: 5,
          select: { currentScore: true },
        }),
      ]);
      const avgTop5 =
        top5.length > 0
          ? Math.round(
              (top5.reduce((a, r) => a + (r.currentScore ?? 0), 0) /
                top5.length) *
                10
            ) / 10
          : null;
      return {
        slug: p.slug,
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
        total,
        eligible,
        testedRecently7d: recentCount,
        avgTop5,
      };
    })
  );

  // ── Top / bottom services ─────────────────────────────────────
  // Pull the latest ServiceScore per service via distinct-on
  // serviceId so the ranking can never lock onto a stale row.
  // sampleCount > 0 filters out legacy rows from before the
  // last-test-only refactor (those default to sampleCount=0 with
  // a stale currentScore from the old Bayesian engine).
  const latestPerService = await prisma.serviceScore.findMany({
    where: { sampleCount: { gt: 0 } },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
    include: {
      service: {
        select: {
          id: true,
          name: true,
          platform: true,
          lastTestedAt: true,
          active: true,
        },
      },
    },
  });

  const sortedDesc = [...latestPerService].sort(
    (a, b) => b.currentScore - a.currentScore
  );
  const sortedAscActive = latestPerService
    .filter((r) => r.service.active)
    .sort((a, b) => a.currentScore - b.currentScore);

  const toRow = (r: (typeof latestPerService)[number]) => ({
    id: r.service.id,
    name: r.service.name,
    platform: r.service.platform,
    score: Math.round(r.currentScore * 10) / 10,
    timeToFiftyMin: r.avgTimeToFiftyMin
      ? Math.round(r.avgTimeToFiftyMin)
      : null,
    dropPct:
      r.avgDropPct !== null
        ? Math.round(r.avgDropPct * 1000) / 10
        : null,
    lastTestedAt: r.service.lastTestedAt?.toISOString() ?? null,
  });
  const topServices = sortedDesc.slice(0, 10).map(toRow);
  const bottomServices = sortedAscActive.slice(0, 10).map(toRow);

  // ── Recent events (mix of TestOrders + Alerts) ────────────────
  const [recentOrders, recentAlerts] = await Promise.all([
    prisma.testOrder.findMany({
      orderBy: { placedAt: "desc" },
      take: 40,
      include: {
        service: { select: { name: true, platform: true } },
      },
    }),
    prisma.alert.findMany({
      where: { lastTriggeredAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } },
      orderBy: { lastTriggeredAt: "desc" },
      take: 15,
    }),
  ]);
  type EventRow = {
    at: string;
    kind: string;
    title: string;
    subtitle: string;
    color: string;
  };
  const events: EventRow[] = [];
  for (const o of recentOrders) {
    const kind =
      o.status === "running"
        ? "PLACED"
        : o.status === "completed"
          ? "COMPLETED"
          : o.status === "aborted_target_died"
            ? "ABORTED"
            : o.status.toUpperCase();
    const color =
      o.status === "running"
        ? "#66CCFF"
        : o.status === "completed"
          ? "#00CC66"
          : o.status === "aborted_target_died"
            ? "#FF3300"
            : "#CCCCCC";
    events.push({
      at: o.placedAt.toISOString(),
      kind,
      title: o.service?.name?.slice(0, 80) ?? `service#${o.serviceId}`,
      subtitle:
        (o.service?.platform?.toUpperCase() ?? "—") +
        (o.retryCount > 0 ? ` · retry ${o.retryCount}` : "") +
        (o.dryRun ? " · dry-run" : ""),
      color,
    });
  }
  for (const a of recentAlerts) {
    events.push({
      at: a.lastTriggeredAt.toISOString(),
      kind: "ALERT",
      title: a.title,
      subtitle: `${a.severity} · ${a.category}`,
      color:
        a.severity === "critical"
          ? "#FF3300"
          : a.severity === "warning"
            ? "#FFCC00"
            : "#CCCCCC",
    });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const recentEvents = events.slice(0, 50);

  // ── Activity heatmap 7d × 24h ─────────────────────────────────
  const heatmapRows = await prisma.testOrder.findMany({
    where: { placedAt: { gte: last7d } },
    select: { placedAt: true },
  });
  // 7 rows (days ago: 6..0 where 0 = today) × 24 cols (hour 0..23)
  const heatmap = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  const startHour = Math.floor(last7d.getTime() / 3600_000);
  for (const r of heatmapRows) {
    const hrIndex = Math.floor(r.placedAt.getTime() / 3600_000) - startHour;
    if (hrIndex < 0) continue;
    const day = Math.floor(hrIndex / 24); // 0..6
    const hour = hrIndex % 24;
    if (day >= 0 && day < 7) heatmap[day][hour]++;
  }

  // ── Scoring campaign (if any active) ──────────────────────────
  const campaign = await getActiveCampaign();

  // ── Brute placement campaign (#2 et au-delà) ──────────────────
  const { getActiveBruteCampaign } = await import(
    "@/lib/scoring/brute-campaign"
  );
  const bruteCampaign = await getActiveBruteCampaign();

  // ── Catalogue lifecycle ───────────────────────────────────────
  const { lifecycleCounts } = await import("@/lib/catalogue/lifecycle");
  const catalogueLifecycle = await lifecycleCounts();

  // ── Catalogue sync status (last run + 30-day rollup) ──────────
  const { getCatalogueSyncStatus } = await import(
    "@/lib/catalogue/health-check"
  );
  const catalogueSync = await getCatalogueSyncStatus();

  // ── BulkMedya balance retry budget ───────────────────────────
  const { getBalanceRetryBudget } = await import(
    "@/lib/balance/retry-budget"
  );
  const balanceRetry = await getBalanceRetryBudget();

  return {
    generatedAt: new Date().toISOString(),
    globalStats,
    testsByHour,
    statusDistribution,
    scoreDistribution,
    rapidApiUsage,
    productBreakdown,
    topServices,
    bottomServices,
    recentEvents,
    heatmap,
    campaign,
    bruteCampaign,
    catalogueLifecycle,
    catalogueSync,
    balanceRetry,
  };
}

function bucketPerHour(
  rows: Array<{ placedAt: Date; status: string; dryRun: boolean }>,
  from: Date,
  to: Date
): Array<{ hour: string; placed: number; real: number; dry: number }> {
  const fromH = Math.floor(from.getTime() / 3600_000);
  const toH = Math.floor(to.getTime() / 3600_000);
  const span = toH - fromH + 1; // inclusive
  const buckets: Array<{
    hour: string;
    placed: number;
    real: number;
    dry: number;
  }> = [];
  for (let i = 0; i < span; i++) {
    const t = new Date((fromH + i) * 3600_000);
    buckets.push({
      hour: `${t.getUTCHours().toString().padStart(2, "0")}:00`,
      placed: 0,
      real: 0,
      dry: 0,
    });
  }
  for (const r of rows) {
    const idx = Math.floor(r.placedAt.getTime() / 3600_000) - fromH;
    if (idx < 0 || idx >= span) continue;
    buckets[idx].placed++;
    if (r.dryRun) buckets[idx].dry++;
    else buckets[idx].real++;
  }
  return buckets;
}
