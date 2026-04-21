// Every 15 minutes, top up PoolSeedSuggestionPool for both platforms
// when the count drops below POOL_REFILL_THRESHOLD. Keeps the /pool
// seeds suggestions column instant for operators — they never wait
// on a Claude round-trip because we always have at least ~50 cached
// entries ready to serve.
//
// Auth: Bearer CRON_SECRET (Vercel Cron sets the header automatically).

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  getPoolCount,
  refillSuggestionPool,
  POOL_REFILL_THRESHOLD,
  type PlatformId,
} from "@/lib/pool/suggestion-pool";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const platforms: PlatformId[] = ["instagram", "tiktok"];
  const results: Array<
    | { platform: PlatformId; skipped: true; count: number }
    | Awaited<ReturnType<typeof refillSuggestionPool>>
    | { platform: PlatformId; error: string }
  > = [];

  for (const p of platforms) {
    try {
      const count = await getPoolCount(p);
      if (count >= POOL_REFILL_THRESHOLD) {
        results.push({ platform: p, skipped: true, count });
        continue;
      }
      results.push(await refillSuggestionPool(p));
    } catch (e) {
      results.push({ platform: p, error: (e as Error).message });
    }
  }
  return NextResponse.json({ ok: true, results });
}

export const GET = POST;
