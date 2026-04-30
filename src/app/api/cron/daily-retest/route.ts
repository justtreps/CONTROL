// Hourly: pick MONITORED candidates whose service hasn't been
// tested in the last 24h, place one test per service (dedup by
// serviceId — a service may appear on multiple products), capped
// at RETESTS_PER_HOUR so load stays flat across the day.
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

// Per-tick caps. Must fit inside maxDuration=300s. Observed
// per-test wall-time for attemptPlaceOrder: ~3-5s normal, up to
// 15s on retry chains, 30s on fetch hard-cap. With pool
// degradation pushing more attempts onto retry chains, the
// previous cap of 300 + concurrency 16 was timing out at 300s.
// Cut the cap and add a tick budget so the function returns a
// real payload instead of dying on a 504. We deliberately don't
// chase the 3x/day target on a single tick — daily-retest fires
// hourly so the system catches up across multiple ticks.
const RETESTS_PER_HOUR = 100;
const TICK_BUDGET_MS = 250_000;
// Each attemptPlaceOrder does 2 RapidAPI calls (oracle baseline +
// follower sample) + BulkMedya placement + several DB writes. With
// fetch hard-cap at 30 s each and tail-latency stacking, 90 s
// gives enough room for the legit p99 case while still catching a
// genuinely hung attempt. 30 s was cutting off most real
// placements (observed 92 / 100 timing out, 0 placed).
const PER_TEST_WALL_MS_BUDGET = 90_000;
const CONCURRENCY = 16;

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

  // 8h per-service cutoff = max 3 retests/day per service.
  // Earlier 24h cutoff capped retests at 1×/day which made the
  // 30-test moving-average score impossibly slow to fill.
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
