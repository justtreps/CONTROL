// Phase-1 engagement pool fill: exploit the existing follower pool.
//
// Every TestAccount in the follower pool already has a trusted oracle
// read (lastMediaCount + hasPostsInfo=true), so we skip the candidate
// discovery step entirely. For each eligible account we fire ONE
// RapidAPI /user/posts call, filter by freshness + natural-likes, and
// insert each qualifying post as a TestPost row tagged
// scrapeSource='from_follower_pool'.
//
// This is ~2× cheaper than a seed scrape (which does oracle + posts)
// and ~4× cheaper than re-discovering candidates from scratch. Phase 2
// (seed scrape) is only used when this pool is exhausted.

import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "./config";
import {
  fetchInstagramUserPosts,
  instagramPostUrl,
} from "@/lib/rapidapi/instagram";
import {
  fetchTikTokUserVideos,
  tiktokVideoUrl,
} from "@/lib/rapidapi/tiktok";
import { fetchOracleFor } from "./oracle";

export type ExtractStats = {
  target: number;
  platform: "instagram" | "tiktok" | "both";
  startedAt: string;
  addedPosts: number;
  accountsProcessed: number;
  accountsExhausted: number;
  callsUsed: number;
  oracleBackfills: number;
  errors: string[];
  // Cursor — IDs we've already processed in this job so resume ticks
  // don't re-pick the same rows.
  processedAccountIds: number[];
};

export function initExtractStats(
  platform: "instagram" | "tiktok" | "both",
  target: number
): ExtractStats {
  return {
    target,
    platform,
    startedAt: new Date().toISOString(),
    addedPosts: 0,
    accountsProcessed: 0,
    accountsExhausted: 0,
    callsUsed: 0,
    oracleBackfills: 0,
    errors: [],
    processedAccountIds: [],
  };
}

const CONCURRENCY = 8;
const REVISIT_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30d

type CandidateRow = {
  id: number;
  platform: string;
  userId: string;
  username: string;
  hasPostsInfo: boolean;
  lastMediaCount: number | null;
};

export async function runEngagementExtractTranche({
  stats,
  budgetMs,
  stopRequested,
}: {
  stats: ExtractStats;
  budgetMs: number;
  stopRequested: () => Promise<boolean>;
}): Promise<{ done: boolean; stats: ExtractStats }> {
  const cfg = await getPoolConfig();
  const deadline = Date.now() + budgetMs;
  const revisitCutoff = new Date(Date.now() - REVISIT_WINDOW_MS);

  const platforms: string[] =
    stats.platform === "both" ? ["instagram", "tiktok"] : [stats.platform];

  while (Date.now() < deadline) {
    if (await stopRequested()) return { done: false, stats };
    if (stats.addedPosts >= stats.target) return { done: true, stats };
    if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun)
      return { done: true, stats };

    // Fetch next wave of eligible follower-pool accounts. Primary
    // path: hasPostsInfo=true AND lastMediaCount>=1 (cheapest — we
    // can go straight to /user/posts). Fallback: hasPostsInfo=false
    // (legacy rows) — we'll spend one extra oracle call per account
    // to backfill mediaCount before deciding.
    const batch = await prisma.testAccount.findMany({
      where: {
        accountType: "follower_test",
        status: { not: "invalid" },
        platform: { in: platforms },
        engagementExhausted: false,
        OR: [
          { engagementCheckedAt: null },
          { engagementCheckedAt: { lt: revisitCutoff } },
        ],
        id: { notIn: stats.processedAccountIds },
      },
      select: {
        id: true,
        platform: true,
        userId: true,
        username: true,
        hasPostsInfo: true,
        lastMediaCount: true,
      },
      orderBy: [
        // Prioritize fast-path (hasPostsInfo=true) then never-checked
        // rows — keeps cost per added post minimal.
        { hasPostsInfo: "desc" },
        { engagementCheckedAt: { sort: "asc", nulls: "first" } },
      ],
      take: CONCURRENCY * 4,
    });

    if (batch.length === 0) return { done: true, stats };

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      if (Date.now() > deadline) break;
      if (await stopRequested()) return { done: false, stats };
      if (stats.addedPosts >= stats.target) return { done: true, stats };
      if (stats.callsUsed >= cfg.maxRapidapiCallsPerScrapeRun)
        return { done: true, stats };
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map((row) => processOne(row, stats, cfg)));
    }
  }

  return { done: false, stats };
}

async function processOne(
  row: CandidateRow,
  stats: ExtractStats,
  cfg: Awaited<ReturnType<typeof getPoolConfig>>
): Promise<void> {
  // Always mark the row as processed for this job so we don't re-read
  // it on the next wave (regardless of success / exhaustion / error).
  stats.processedAccountIds.push(row.id);
  stats.accountsProcessed++;

  // Legacy backfill path — hasPostsInfo=false means the oracle read
  // from scrape-time is stale or missing. One extra /userinfo call
  // refreshes mediaCount + flips the flag; future extract runs take
  // the fast path on this row.
  let mediaCount = row.lastMediaCount ?? 0;
  if (!row.hasPostsInfo) {
    try {
      const oracle = await fetchOracleFor(row.platform, row.userId);
      stats.callsUsed++;
      stats.oracleBackfills++;
      if (!oracle.ok) {
        // Can't decide — mark checked so we don't retry for 30d.
        await prisma.testAccount.update({
          where: { id: row.id },
          data: {
            engagementCheckedAt: new Date(),
            engagementPostsFound: 0,
            engagementExhausted: true,
          },
        });
        stats.accountsExhausted++;
        return;
      }
      mediaCount = oracle.mediaCount;
      await prisma.testAccount.update({
        where: { id: row.id },
        data: {
          hasPostsInfo: true,
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
        },
      });
    } catch (e) {
      stats.errors.push(
        `#${row.id} oracle: ${(e as Error).message.slice(0, 100)}`
      );
      return;
    }
  }

  if (mediaCount < 1) {
    // Skip — nothing to extract. Mark exhausted so we don't revisit
    // until the 30d window opens OR a health check refreshes the row.
    await prisma.testAccount.update({
      where: { id: row.id },
      data: {
        engagementCheckedAt: new Date(),
        engagementPostsFound: 0,
        engagementExhausted: true,
      },
    });
    stats.accountsExhausted++;
    return;
  }

  // Fetch the recent posts. One RapidAPI call per account.
  const maxAgeMs = (cfg.engagementFreshnessMaxDays ?? 30) * 24 * 3600 * 1000;
  const nowMs = Date.now();
  const maxLikes = cfg.engagementLikesMaxPerPost ?? 20;

  try {
    type Valid = {
      mediaId: string;
      mediaUrl: string;
      mediaType: string;
      postedAt: Date | null;
      likeCount: number;
    };
    const valid: Valid[] = [];

    if (row.platform === "instagram") {
      const { posts } = await fetchInstagramUserPosts(row.userId, 10);
      stats.callsUsed++;
      for (const p of posts) {
        if (p.likeCount > maxLikes) continue;
        if (p.takenAt !== null && nowMs - p.takenAt > maxAgeMs) continue;
        valid.push({
          mediaId: p.mediaId,
          mediaUrl: instagramPostUrl(p),
          mediaType: p.mediaType,
          postedAt: p.takenAt ? new Date(p.takenAt) : null,
          likeCount: p.likeCount,
        });
      }
    } else if (row.platform === "tiktok") {
      const { videos } = await fetchTikTokUserVideos(row.userId, 10);
      stats.callsUsed++;
      for (const v of videos) {
        if (v.likeCount > maxLikes) continue;
        if (v.createTime !== null && nowMs - v.createTime > maxAgeMs) continue;
        valid.push({
          mediaId: v.mediaId,
          mediaUrl: tiktokVideoUrl(v),
          mediaType: "video",
          postedAt: v.createTime ? new Date(v.createTime) : null,
          likeCount: v.likeCount,
        });
      }
    }

    if (valid.length === 0) {
      await prisma.testAccount.update({
        where: { id: row.id },
        data: {
          engagementCheckedAt: new Date(),
          engagementPostsFound: 0,
          engagementExhausted: true,
        },
      });
      stats.accountsExhausted++;
      return;
    }

    const created = await prisma.testPost.createMany({
      data: valid.map((v) => ({
        testAccountId: row.id,
        platform: row.platform,
        mediaId: v.mediaId,
        mediaUrl: v.mediaUrl,
        mediaType: v.mediaType,
        postedAt: v.postedAt,
        naturalLikesCount: v.likeCount,
        status: "available",
        scrapeSource: "from_follower_pool",
      })),
      skipDuplicates: true,
    });

    await prisma.testAccount.update({
      where: { id: row.id },
      data: {
        engagementCheckedAt: new Date(),
        engagementPostsFound: created.count,
        engagementExhausted: created.count === 0,
      },
    });
    stats.addedPosts += created.count;
    if (created.count === 0) stats.accountsExhausted++;
  } catch (e) {
    stats.errors.push(`#${row.id}: ${(e as Error).message.slice(0, 120)}`);
  }
}
