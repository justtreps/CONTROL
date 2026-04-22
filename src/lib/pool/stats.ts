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

async function accountStatusBreakdown(
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

// Engagement pool breakdown — counts TestPost rows (the pool entity)
// grouped by status. A single parent TestAccount can contribute many
// rows so these numbers are NOT summable with the follower pool.
async function postStatusBreakdown(
  platform: string
): Promise<StatusBreakdown> {
  const rows = await prisma.testPost.groupBy({
    by: ["status"],
    where: { platform },
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

async function followerCountryBreakdown(): Promise<
  Array<{ country: string | null; count: number }>
> {
  const rows = await prisma.testAccount.groupBy({
    by: ["detectedCountry"],
    where: {
      accountType: "follower_test",
      status: { in: ["available", "assigned"] },
    },
    _count: { _all: true },
    orderBy: { _count: { detectedCountry: "desc" } },
    take: 6,
  });
  return rows.map((r) => ({ country: r.detectedCountry, count: r._count._all }));
}

// Engagement country breakdown rides off the parent account's
// detectedCountry. Grouped raw SQL would be faster but we only need
// a top-6, so a single join + in-memory aggregation is fine.
async function engagementCountryBreakdown(): Promise<
  Array<{ country: string | null; count: number }>
> {
  const posts = await prisma.testPost.findMany({
    where: { status: { in: ["available", "assigned"] } },
    select: { testAccount: { select: { detectedCountry: true } } },
  });
  const byCountry = new Map<string | null, number>();
  for (const p of posts) {
    const c = p.testAccount.detectedCountry ?? null;
    byCountry.set(c, (byCountry.get(c) ?? 0) + 1);
  }
  return Array.from(byCountry.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([country, count]) => ({ country, count }));
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
    accountStatusBreakdown("instagram"),
    accountStatusBreakdown("tiktok"),
    accountStatusBreakdown("instagram", "follower_test"),
    accountStatusBreakdown("tiktok", "follower_test"),
    postStatusBreakdown("instagram"),
    postStatusBreakdown("tiktok"),
    followerCountryBreakdown(),
    engagementCountryBreakdown(),
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

// Daily rollup for the 30-day history graph. Computed live from the
// primary pool entity (TestAccount for follower, TestPost for
// engagement) so the graph shows what actually happened in that
// universe instead of a catch-all total.
export async function getPoolHistory30d(
  pool: "follower" | "engagement"
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

  // For each of the last 30 days, compute what each status count WOULD
  // have been at that day's end. Uses firstSeenAt / assignedAt /
  // consumedAt / invalidatedAt to reconstruct state.
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const endOfDay = new Date(d.getTime() + 24 * 3600 * 1000 - 1);

    const accountBreakdown = async (platform: string): Promise<StatusBreakdown> => {
      const typeFilter = { accountType: "follower_test" };
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
      return { available, assigned, consumed, invalid, archived: 0 };
    };

    const postBreakdown = async (platform: string): Promise<StatusBreakdown> => {
      const [seen, assigned, consumed, invalid] = await Promise.all([
        prisma.testPost.count({
          where: { platform, firstSeenAt: { lte: endOfDay } },
        }),
        prisma.testPost.count({
          where: {
            platform,
            assignedAt: { lte: endOfDay, not: null },
            OR: [
              { consumedAt: null },
              { consumedAt: { gt: endOfDay } },
            ],
          },
        }),
        prisma.testPost.count({
          where: { platform, consumedAt: { lte: endOfDay, not: null } },
        }),
        prisma.testPost.count({
          where: { platform, invalidatedAt: { lte: endOfDay, not: null } },
        }),
      ]);
      const available = Math.max(0, seen - assigned - consumed - invalid);
      return { available, assigned, consumed, invalid, archived: 0 };
    };

    const breakdown = pool === "follower" ? accountBreakdown : postBreakdown;

    const [ig, tt] = await Promise.all([
      breakdown("instagram"),
      breakdown("tiktok"),
    ]);

    days.push({ date: d.toISOString().slice(0, 10), instagram: ig, tiktok: tt });
  }

  return days;
}
