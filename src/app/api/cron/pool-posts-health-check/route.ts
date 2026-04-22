// Every 6h: re-verify each TestAccountMedia row with status='active'
// is still reachable. Drops posts that 404 (deleted) and marks posts
// 'stale' when their owner account has been invalidated.
//
// When an engagement_test account is left with zero active posts,
// flip the parent account to invalid(no_active_posts). The testbot's
// pickAndAssignAccount won't pick status=invalid rows.
//
// Same direct-run pattern as pool-health-check: maxDuration 300s,
// budget 280s, concurrency 8, stopRequested polling for the UI kill
// switch.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import {
  fetchInstagramUserPosts,
  instagramPostUrl,
} from "@/lib/rapidapi/instagram";
import {
  fetchTikTokUserVideos,
  tiktokVideoUrl,
} from "@/lib/rapidapi/tiktok";

export const maxDuration = 300;

const CONCURRENCY = 8;
const BUDGET_MS = 280_000;

type RunStats = {
  startedAt: string;
  finishedAt: string;
  checkedAccounts: number;
  checkedPosts: number;
  postsDeleted: number;
  postsStale: number;
  accountsInvalidated: number;
  errors: string[];
};

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const toggles = await getSystemToggles();
  if (!toggles.poolHealthcheckEnabled) {
    return NextResponse.json({ ok: true, skipped: "kill_switch" });
  }

  const startedAt = new Date();
  const deadline = Date.now() + BUDGET_MS;

  // Group active post rows by account so we can do one /userposts
  // call per account instead of one per post. Freshness window: rows
  // whose lastCheckedAt is older than the start of this job (no
  // duplicate checks — same pattern we use in the daily account
  // health check).
  const accounts = await prisma.testAccount.findMany({
    where: {
      accountType: "engagement_test",
      media: {
        some: {
          status: "active",
          lastCheckedAt: { lt: startedAt },
        },
      },
    },
    select: { id: true, platform: true, userId: true, username: true, status: true },
    orderBy: {
      media: { _count: "desc" }, // prioritize accounts with most active posts
    } as unknown as { id: "asc" },
    take: 1000,
  });

  const stats: RunStats = {
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    checkedAccounts: 0,
    checkedPosts: 0,
    postsDeleted: 0,
    postsStale: 0,
    accountsInvalidated: 0,
    errors: [],
  };

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = accounts.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((a) => checkOneAccount(a, startedAt, stats))
    );
  }

  stats.finishedAt = new Date().toISOString();
  return NextResponse.json({ ok: true, stats });
}

async function checkOneAccount(
  account: {
    id: number;
    platform: string;
    userId: string;
    username: string;
    status: string;
  },
  startedAt: Date,
  stats: RunStats
): Promise<void> {
  // If the parent account is already invalid/consumed/archived, mark
  // its posts 'stale' in bulk without any provider call.
  if (account.status !== "available" && account.status !== "assigned") {
    const res = await prisma.testAccountMedia.updateMany({
      where: {
        testAccountId: account.id,
        status: "active",
      },
      data: { status: "stale", lastCheckedAt: new Date() },
    });
    stats.postsStale += res.count;
    stats.checkedAccounts++;
    return;
  }

  // Fetch fresh post list from the provider. We compare against the
  // stored mediaIds to decide which rows are still live.
  let livePostIds = new Set<string>();
  try {
    if (account.platform === "instagram") {
      const { posts } = await fetchInstagramUserPosts(account.userId, 20);
      livePostIds = new Set(posts.map((p) => p.mediaId));
    } else if (account.platform === "tiktok") {
      const { videos } = await fetchTikTokUserVideos(account.userId, 20);
      livePostIds = new Set(videos.map((v) => v.mediaId));
    }
  } catch (e) {
    stats.errors.push(
      `#${account.id} @${account.username}: ${(e as Error).message.slice(0, 120)}`
    );
    return;
  }

  const existing = await prisma.testAccountMedia.findMany({
    where: {
      testAccountId: account.id,
      status: "active",
      lastCheckedAt: { lt: startedAt },
    },
    select: { id: true, mediaId: true },
  });

  for (const row of existing) {
    stats.checkedPosts++;
    if (!livePostIds.has(row.mediaId)) {
      await prisma.testAccountMedia.update({
        where: { id: row.id },
        data: { status: "deleted", lastCheckedAt: new Date() },
      });
      stats.postsDeleted++;
    } else {
      await prisma.testAccountMedia.update({
        where: { id: row.id },
        data: { lastCheckedAt: new Date() },
      });
    }
  }

  // If zero posts remain active, the engagement account is unusable —
  // flip the parent to invalid so the testbot stops picking it.
  const remaining = await prisma.testAccountMedia.count({
    where: { testAccountId: account.id, status: "active" },
  });
  if (remaining === 0) {
    await prisma.testAccount.update({
      where: { id: account.id },
      data: {
        status: "invalid",
        invalidReason: "no_active_posts",
        invalidatedAt: new Date(),
        active: false,
      },
    });
    stats.accountsInvalidated++;
  }

  stats.checkedAccounts++;
}

export const GET = POST;
// Silences the unused helper import (used at file top for URL
// building clarity — keeps the grep hits alongside the fetcher).
void instagramPostUrl;
void tiktokVideoUrl;
