// Every 6h: re-verify each TestPost row with status='available' is
// still reachable. Flips 404 rows to invalid('deleted') and also
// sweeps posts whose parent account is now invalid into invalid
// ('parent_invalid') in bulk.
//
// Direct-run pattern: maxDuration 300s, budget 280s, concurrency 8.

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
  postsCascaded: number;
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

  // Pre-sweep: any available post whose parent account is no longer
  // usable gets flipped to invalid(parent_invalid) in one statement —
  // far cheaper than re-fetching each provider side.
  const cascaded = await prisma.testPost.updateMany({
    where: {
      status: "available",
      testAccount: {
        status: { notIn: ["available", "assigned"] },
      },
    },
    data: {
      status: "invalid",
      invalidReason: "parent_invalid",
      invalidatedAt: startedAt,
      active: false,
    },
  });

  // Group remaining available posts by parent account so we do 1
  // provider call per account (each /userposts returns up to 20) and
  // compare the live mediaId set against our stored rows.
  const accounts = await prisma.testAccount.findMany({
    where: {
      accountType: "engagement_test",
      status: { in: ["available", "assigned"] },
      posts: {
        some: {
          status: "available",
          lastCheckedAt: { lt: startedAt },
        },
      },
    },
    select: { id: true, platform: true, userId: true, username: true },
    take: 1000,
  });

  const stats: RunStats = {
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    checkedAccounts: 0,
    checkedPosts: 0,
    postsDeleted: 0,
    postsCascaded: cascaded.count,
    errors: [],
  };

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = accounts.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((a) => checkOneAccount(a, startedAt, stats)));
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
  },
  startedAt: Date,
  stats: RunStats
): Promise<void> {
  // Fetch fresh post list from the provider.
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

  const existing = await prisma.testPost.findMany({
    where: {
      testAccountId: account.id,
      status: "available",
      lastCheckedAt: { lt: startedAt },
    },
    select: { id: true, mediaId: true },
  });

  for (const row of existing) {
    stats.checkedPosts++;
    if (!livePostIds.has(row.mediaId)) {
      await prisma.testPost.update({
        where: { id: row.id },
        data: {
          status: "invalid",
          invalidReason: "deleted",
          invalidatedAt: new Date(),
          active: false,
          lastCheckedAt: new Date(),
        },
      });
      stats.postsDeleted++;
    } else {
      await prisma.testPost.update({
        where: { id: row.id },
        data: { lastCheckedAt: new Date() },
      });
    }
  }

  stats.checkedAccounts++;
}

export const GET = POST;
// Silences the unused helper imports (URL builders documented here
// for future extensions — same pattern as the scraper).
void instagramPostUrl;
void tiktokVideoUrl;
