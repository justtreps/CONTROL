// Hourly: pick QUALIFIED + MONITORED candidates whose service
// hasn't been tested in the last 8 h, place one test per service
// (dedup by serviceId — a service may appear on multiple
// products), capped at RETESTS_PER_HOUR so load stays flat
// across the day.
//
// 8 h cutoff = 3 retests/day per service. With ~813 services on
// QUALIFIED+MONITORED, the natural 8 h spread keeps load bounded
// without needing per-type quotas — the lastTestedAt filter
// distributes tests across the day on its own. If TT or engagement
// look thin in a 24 h window, the bottleneck is upstream (pool
// empty / oracle dead / engagement placement broken), not the
// retest cap.
//
// Reuses lib/testbot.ts:attemptPlaceOrder for the actual
// placement — same pool pick, same oracle baseline, same
// BulkMedya order. The only difference from a campaign test is
// the entry point.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";
import { attemptPlaceOrder } from "@/lib/testbot";
import {
  acquireKeyForNewJob,
  flushUsage,
  withApiKey,
} from "@/lib/rapidapi/key-manager";
import type { Service } from "@prisma/client";

// Per-tick caps. Must fit inside maxDuration=300 s.
//
// Capacity math (operator request 2026-05-02):
//   813 QUALIFIED+MONITORED services × 3 retests/day = 2439/day
//   /24 h = ~102/h average. Target 200/h ceiling so a stalled
//   tick can be absorbed in a couple of catch-up ticks instead
//   of dripping forever.
//
// Wall-time per attempt observed: 3-5 s nominal, 8-15 s on
// retry-private chains, up to 30 s on fetch hard-cap. With the
// new engagement post-oracle path attemptPlaceOrder makes one
// additional RapidAPI call (parent ghost check + post lookup) for
// engagement services — bumps avg p95 by ~3 s.
//
// Wall-budget × concurrency vs cap:
//   280 s × 4 workers / 5 s avg = 224 tests/tick (matches 200 cap)
//   280 s × 4 workers / 15 s p95 = 75 tests/tick → ~1.8 k/day
// 200 cap is the queue ceiling; the wall budget is the actual
// throttle. Cap > wall is intentional so a tick that finishes
// fast can land more than wall_avg.
const RETESTS_PER_HOUR = 200;
// 280 s leaves 20 s margin under maxDuration=300 so the function
// returns a payload instead of dying on a 504.
const TICK_BUDGET_MS = 280_000;
// 90 s ceiling per attempt — fetch oracle (≤30 s) + sample
// (≤30 s) + BulkMedya + DB ops + engagement post-oracle.
const PER_TEST_WALL_MS_BUDGET = 90_000;
// Concurrency 4 keeps RapidAPI throughput ~0.8 req/s aggregate,
// well under the 170/min limit (2 keys × 85). Previous cap of 16
// was firing 60+ requests/s in burst, saturating the per-key
// sliding window for 60 s and blocking subsequent crons (testbot-
// poll observed 8/8 = rate_limit_slot_wait_timeout after each
// daily-retest tick). Engagement attempts add 1 extra call so the
// 4-worker ceiling is the right side of the rate-limit envelope.
const CONCURRENCY = 4;

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const toggles = await getSystemToggles();
  if (!toggles.dailyRetestEnabled || !toggles.testBotEnabled) {
    return NextResponse.json({
      ok: true,
      skipped: !toggles.dailyRetestEnabled
        ? "daily_retest_disabled"
        : "test_bot_disabled",
    });
  }

  // 8 h per-service cutoff = max 3 retests/day per service. A
  // service tested at 00:00 is eligible again at 08:00, then 16:00,
  // then 00:00. The natural staggering means we don't need
  // explicit type/platform quotas — the filter does the spreading.
  const cutoff = new Date(Date.now() - 8 * 60 * 60_000);

  // Candidates with lifecycleStatus IN (QUALIFIED, MONITORED).
  // QUALIFIED was excluded before — bug: a service needs ≥2
  // delivered TestOrders to flip QUALIFIED → MONITORED, and the
  // 2nd order can only come from a retest. Excluding QUALIFIED
  // from retests created a catch-22 where 491 services sat at
  // n=1 forever waiting for a 2nd test that never came.
  const cands = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: { in: ["QUALIFIED", "MONITORED"] },
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [{ lastTestedAt: null }, { lastTestedAt: { lt: cutoff } }],
      },
    },
    include: {
      service: true,
    },
    take: RETESTS_PER_HOUR * 4, // pull extra for dedup
  });

  const seen = new Set<number>();
  const queue: Service[] = [];
  for (const c of cands) {
    if (!c.service || seen.has(c.service.id)) continue;
    seen.add(c.service.id);
    queue.push(c.service as Service);
    if (queue.length >= RETESTS_PER_HOUR) break;
  }

  // Key round-robin across all active RapidAPI keys — same
  // strategy as the campaign runner. withApiKey scopes ALS so
  // every IG call under the wrap uses the chosen key.
  const activeKeys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram", status: "active" },
    select: { id: true, token: true, provider: true },
  });
  // Make sure we have at least a fallback key — acquireKeyForNewJob
  // seeds the table from the env var on first boot.
  if (activeKeys.length === 0) await acquireKeyForNewJob("instagram");

  const result = {
    ok: true,
    considered: cands.length,
    placed: 0,
    skipped: 0,
    aborted: 0,
    budgetExceeded: false,
  };
  const simulated = !toggles.testBotEnabled || toggles.dryRunMode;
  const tickStart = Date.now();

  // Worker pool — same pattern as testbot-poll. Each worker pulls
  // from a shared cursor, hard-caps each attempt at 30s via
  // Promise.race so a slow upstream can't tie up a whole wave.
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (Date.now() - tickStart > TICK_BUDGET_MS) {
            result.budgetExceeded = true;
            return;
          }
          const idx = cursor++;
          if (idx >= queue.length) return;
          const svc = queue[idx];
          const key = activeKeys.length
            ? activeKeys[idx % activeKeys.length]
            : null;
          const run = async () => {
            try {
              const outcome = await attemptPlaceOrder({ service: svc, simulated });
              if (outcome.kind === "placed") result.placed++;
              else if (outcome.kind === "no_account") result.skipped++;
              else result.aborted++;
            } catch {
              result.aborted++;
            }
          };
          const work = key
            ? withApiKey(
                { id: key.id, token: key.token, provider: key.provider },
                undefined,
                run,
              )
            : run();
          // Hard cap per attempt — even with the fetch Promise.race
          // wrapper, full attemptPlaceOrder can stack DB writes,
          // pool picks, multi-call lifecycle. Cap the whole attempt.
          await Promise.race([
            work.catch(() => {
              result.aborted++;
            }),
            new Promise<void>((resolve) =>
              setTimeout(resolve, PER_TEST_WALL_MS_BUDGET),
            ),
          ]);
        }
      })()
    );
  }
  await Promise.all(workers);

  // Drain in-memory usage counter before Vercel kills the lambda.
  // Otherwise the last batch of recordApiCall() increments — up to
  // RETESTS_PER_HOUR × oracle calls — silently disappears.
  await flushUsage();

  const elapsed = Date.now() - tickStart;
  console.log(
    `[daily-retest] queue=${queue.length} placed=${result.placed} ` +
      `aborted=${result.aborted} skipped=${result.skipped} ` +
      `elapsed=${elapsed}ms ${result.budgetExceeded ? "BUDGET_EXCEEDED" : "ok"}`
  );

  return NextResponse.json(result);
}

export const GET = POST;
