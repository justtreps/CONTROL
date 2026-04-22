// Pool stats helpers — used by /api/pool/stats and the dashboard hero.

import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "./config";

export type StatusBreakdown = {
  available: number;
  assigned: number;
  consumed: number;
  invalid: number;
  archived: number;
};

export type PlatformStats = StatusBreakdown & {
  target: number;
};

export type PoolStats = {
  instagram: PlatformStats;
  tiktok: PlatformStats;
  autoRefillEnabled: boolean;
  lastScrapeAt: string | null;
  nextHealthCheckAt: string | null;
  activeJobs: number;
  // Dual-pool additions — always present even when engagementPool
  // Enabled is false (engagement counts will just be 0). Separate
  // sub-objects keep the existing Hero layout working.
  followerPool: {
    instagram: StatusBreakdown;
    tiktok: StatusBreakdown;
  };
  engagementPool: {
    instagram: StatusBreakdown;
    tiktok: StatusBreakdown;
  };
  countryBreakdown: {
    follower: Array<{ country: string | null; count: number }>;
    engagement: Array<{ country: string | null; count: number }>;
  };
};

async function statusBreakdown(
  platform: string,
  accountType?: "follower_test" | "engagement_test"
): Promise<StatusBreakdown> {
  const where: Record<string, unknown> = { platform };
  if (accountType) where.accountType = accountType;
  const rows = await prisma.testAccount.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const empty: StatusBreakdown = {
    available: 0,
    assigned: 0,
    consumed: 0,
    invalid: 0,
    archived: 0,
  };
  for (const r of rows) {
    if (r.status in empty) {
      empty[r.status as keyof StatusBreakdown] = r._count._all;
    }
  }
  return empty;
}

async function countryBreakdownFor(
  accountType: "follower_test" | "engagement_test"
): Promise<Array<{ country: string | null; count: number }>> {
  const rows = await prisma.testAccount.groupBy({
    by: ["detectedCountry"],
    where: { accountType, status: { in: ["available", "assigned"] } },
    _count: { _all: true },
    orderBy: { _count: { detectedCountry: "desc" } },
    take: 6,
  });
  return rows.map((r) => ({
    country: r.detectedCountry,
    count: r._count._all,
  }));
}

export async function getPoolStats(): Promise<PoolStats> {
  const [
    cfg,
    igBreakdown,
    ttBreakdown,
    igFollower,
    ttFollower,
    igEngagement,
    ttEngagement,
    followerCountries,
    engagementCountries,
    lastScrape,
    activeJobs,
  ] = await Promise.all([
    getPoolConfig(),
    statusBreakdown("instagram"),
    statusBreakdown("tiktok"),
    statusBreakdown("instagram", "follower_test"),
    statusBreakdown("tiktok", "follower_test"),
    statusBreakdown("instagram", "engagement_test"),
    statusBreakdown("tiktok", "engagement_test"),
    countryBreakdownFor("follower_test"),
    countryBreakdownFor("engagement_test"),
    prisma.poolJob.findFirst({
      where: { jobType: "scrape", status: "completed" },
      orderBy: { endedAt: "desc" },
      select: { endedAt: true },
    }),
    prisma.poolJob.count({
      where: { status: { in: ["pending", "running"] } },
    }),
  ]);

  return {
    instagram: { ...igBreakdown, target: cfg.refillTargetInstagram },
    tiktok: { ...ttBreakdown, target: cfg.refillTargetTiktok },
    autoRefillEnabled: cfg.autoRefillEnabled,
    lastScrapeAt: lastScrape?.endedAt?.toISOString() ?? null,
    nextHealthCheckAt: null,
    activeJobs,
    followerPool: { instagram: igFollower, tiktok: ttFollower },
    engagementPool: { instagram: igEngagement, tiktok: ttEngagement },
    countryBreakdown: {
      follower: followerCountries,
      engagement: engagementCountries,
    },
  };
}

// Daily rollup for the 30-day history graph. Computed live from
// existing TestAccount rows — no snapshot table required for v1.
//
// Scoped by accountType so the graph reflects the active universe
// (follower / engagement) instead of a catch-all total. Caller
// passes the pool they want; undefined returns unscoped (legacy).
export async function getPoolHistory30d(
  accountType?: "follower_test" | "engagement_test"
): Promise<
  Array<{
    date: string;
    instagram: StatusBreakdown;
    tiktok: StatusBreakdown;
  }>
> {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const days: Array<{ date: string; instagram: StatusBreakdown; tiktok: StatusBreakdown }> = [];

  // Shared where-slice applied to every count below. Adding accountType
  // here means all 4 point-in-time counts (seen / assigned / consumed /
  // invalid) stay aligned to the same universe.
  const typeFilter = accountType ? { accountType } : {};

  // For each of the last 30 days, compute what each status count WOULD
  // have been at that day's end. Uses firstSeenAt / assignedAt /
  // consumedAt / invalidatedAt to reconstruct state.
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const endOfDay = new Date(d.getTime() + 24 * 3600 * 1000 - 1);

    const breakdown = async (platform: string): Promise<StatusBreakdown> => {
      // available at end-of-day = firstSeenAt <= d AND (not yet assigned/invalid/consumed/archived by then)
      const [seen, assigned, consumed, invalid] = await Promise.all([
        prisma.testAccount.count({
          where: { platform, firstSeenAt: { lte: endOfDay }, ...typeFilter },
        }),
        prisma.testAccount.count({
          where: {
            platform,
            assignedAt: { lte: endOfDay, not: null },
            OR: [
              { consumedAt: null },
              { consumedAt: { gt: endOfDay } },
            ],
            ...typeFilter,
          },
        }),
        prisma.testAccount.count({
          where: {
            platform,
            consumedAt: { lte: endOfDay, not: null },
            ...typeFilter,
          },
        }),
        prisma.testAccount.count({
          where: {
            platform,
            invalidatedAt: { lte: endOfDay, not: null },
            ...typeFilter,
          },
        }),
      ]);
      const available = Math.max(0, seen - assigned - consumed - invalid);
      return {
        available,
        assigned,
        consumed,
        invalid,
        archived: 0,
      };
    };

    const [ig, tt] = await Promise.all([
      breakdown("instagram"),
      breakdown("tiktok"),
    ]);

    days.push({ date: d.toISOString().slice(0, 10), instagram: ig, tiktok: tt });
  }

  return days;
}
