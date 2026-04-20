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
};

async function statusBreakdown(platform: string): Promise<StatusBreakdown> {
  const rows = await prisma.testAccount.groupBy({
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

export async function getPoolStats(): Promise<PoolStats> {
  const [cfg, igBreakdown, ttBreakdown, lastScrape, activeJobs] =
    await Promise.all([
      getPoolConfig(),
      statusBreakdown("instagram"),
      statusBreakdown("tiktok"),
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
    nextHealthCheckAt: null, // best-effort; real cron next-run would need cron parser
    activeJobs,
  };
}

// Daily rollup for the 30-day history graph. Computed live from
// existing TestAccount rows — no snapshot table required for v1.
export async function getPoolHistory30d(): Promise<
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

    const breakdown = async (platform: string): Promise<StatusBreakdown> => {
      // available at end-of-day = firstSeenAt <= d AND (not yet assigned/invalid/consumed/archived by then)
      const [seen, assigned, consumed, invalid] = await Promise.all([
        prisma.testAccount.count({
          where: { platform, firstSeenAt: { lte: endOfDay } },
        }),
        prisma.testAccount.count({
          where: {
            platform,
            assignedAt: { lte: endOfDay, not: null },
            OR: [
              { consumedAt: null },
              { consumedAt: { gt: endOfDay } },
            ],
          },
        }),
        prisma.testAccount.count({
          where: { platform, consumedAt: { lte: endOfDay, not: null } },
        }),
        prisma.testAccount.count({
          where: { platform, invalidatedAt: { lte: endOfDay, not: null } },
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
