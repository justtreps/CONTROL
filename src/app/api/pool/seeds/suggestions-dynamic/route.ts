// GET /api/pool/seeds/suggestions-dynamic?platform=…&count=10
//
// Reads from the PoolSeedSuggestionPool cache in <50ms (typical) and
// triggers a background refill when the cache runs low. Falls back to
// an inline Claude call only when the cache is completely empty for the
// platform (cold-start or after a catastrophic prune). Final fallback
// is the hardcoded lib/pool/suggested-seeds.ts pool.
//
// Response: {
//   rows: [{ platform, username }],
//   count: number,                      // rows length
//   pool_remaining: number,             // after this read, how many cached rows would still satisfy the exclude set
//   source: "cache" | "hybrid" | "claude" | "fallback",
//   refill_triggered: boolean
// }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchCachedSuggestions,
  getPoolCount,
  refillSuggestionPool,
  POOL_REFILL_THRESHOLD,
  type PlatformId,
} from "@/lib/pool/suggestion-pool";
import { suggestedSeedsFor } from "@/lib/pool/suggested-seeds";

export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const count = Math.min(
    20,
    Math.max(1, Number(url.searchParams.get("count") ?? 10) || 10)
  );
  if (platform !== "instagram" && platform !== "tiktok") {
    return NextResponse.json(
      { error: "platform must be instagram or tiktok" },
      { status: 400 }
    );
  }
  const plat = platform as PlatformId;

  // Build the exclude set: active seeds + integrated/rejected history.
  const [activeSeeds, acted] = await Promise.all([
    prisma.poolSeedAccount.findMany({
      where: { platform: plat },
      select: { username: true },
    }),
    prisma.poolSeedSuggestionAction.findMany({
      where: { platform: plat },
      select: { username: true },
    }),
  ]);
  const excludeSet = new Set<string>([
    ...activeSeeds.map((s) => s.username.toLowerCase()),
    ...acted.map((s) => s.username.toLowerCase()),
  ]);

  // Read from cache.
  const { rows, total } = await fetchCachedSuggestions({
    platform: plat,
    count,
    excludeSet,
  });

  const poolCount = await getPoolCount(plat);
  const cacheHasEnough = rows.length >= count;

  // --- Happy path: serve from cache, maybe trigger background refill ---
  if (rows.length > 0) {
    let refillTriggered = false;
    if (poolCount < POOL_REFILL_THRESHOLD) {
      kickOffRefill(plat);
      refillTriggered = true;
    }
    return NextResponse.json({
      rows: rows.map((username) => ({ platform: plat, username })),
      count: rows.length,
      pool_remaining: Math.max(0, total - rows.length),
      source: cacheHasEnough ? "cache" : "hybrid",
      refill_triggered: refillTriggered,
    });
  }

  // --- Cold-start path: cache empty, do a synchronous Claude refill ----
  // This is the "first visit after deploy / after the pool was wiped"
  // case. We synchronously refill so the user sees suggestions at all.
  try {
    const result = await refillSuggestionPool(plat);
    const again = await fetchCachedSuggestions({
      platform: plat,
      count,
      excludeSet,
    });
    return NextResponse.json({
      rows: again.rows.map((username) => ({ platform: plat, username })),
      count: again.rows.length,
      pool_remaining: Math.max(0, again.total - again.rows.length),
      source: result.source, // "claude" or "fallback"
      refill_triggered: true,
    });
  } catch (e) {
    // --- Ultimate fallback: serve straight from the hardcoded list ---
    console.error(
      "[suggestions-dynamic] cold-start refill failed:",
      (e as Error).message
    );
    const hard = suggestedSeedsFor(plat)
      .filter((u) => !excludeSet.has(u.toLowerCase()))
      .slice(0, count);
    return NextResponse.json({
      rows: hard.map((username) => ({ platform: plat, username })),
      count: hard.length,
      pool_remaining: 0,
      source: "fallback",
      refill_triggered: false,
    });
  }
}

// Fire-and-forget refill. We don't await — the user gets their cached
// rows immediately and Vercel's runtime completes the promise in the
// background. If the invocation dies before it finishes, the 15-min
// cron will catch up on the next tick. Either way, the cache stays
// within acceptable drift of POOL_TARGET.
function kickOffRefill(platform: PlatformId) {
  void refillSuggestionPool(platform).catch((e) => {
    console.error(
      `[suggestions-dynamic] background refill for ${platform} failed:`,
      (e as Error).message
    );
  });
}
