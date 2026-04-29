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
// 15s on retry chains. CONCURRENCY=5 with RETESTS_PER_HOUR=200
// caused 504 timeouts at 300s. Bumped concurrency to 12 so the
// drain runs in ~50-70s steady, ~150s worst-case.
const RETESTS_PER_HOUR = 200;
const PER_TEST_WALL_MS_BUDGET = 10_000;
const CONCURRENCY = 12;

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
  };
  const simulated = !toggles.testBotEnabled || toggles.dryRunMode;

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const wave = queue.slice(i, i + CONCURRENCY);
    await Promise.all(
      wave.map(async (svc, j) => {
        const key = activeKeys.length
          ? activeKeys[(i + j) % activeKeys.length]
          : null;
        const run = async () => {
          // Compare-and-swap claim: bump Service.lastTestedAt to
          // NOW iff it's still < cutoff. If a parallel cron tick
          // already claimed this service, count===0 and we skip.
          // Without this, two overlapping ticks (Vercel can fire a
          // new hourly run before the previous finishes) would
          // both pick the same `cands` set and both place a real
          // BulkMedya order on every service in the queue —
          // doubling the daily budget and exhausting the pool.
          const claim = await prisma.service.updateMany({
            where: {
              id: svc.id,
              OR: [
                { lastTestedAt: null },
                { lastTestedAt: { lt: cutoff } },
              ],
            },
            data: { lastTestedAt: new Date() },
          });
          if (claim.count === 0) {
            result.skipped++;
            return;
          }
          const started = Date.now();
          const guard = setTimeout(() => {
            // no-op — attemptPlaceOrder should respect its own
            // internal timeouts; this guard exists to silence the
            // lint's "variable assigned but never read" on a bare
            // void call.
          }, PER_TEST_WALL_MS_BUDGET);
          try {
            const outcome = await attemptPlaceOrder({ service: svc, simulated });
            if (outcome.kind === "placed") result.placed++;
            else if (outcome.kind === "no_account") result.skipped++;
            else result.aborted++;
          } catch {
            result.aborted++;
          } finally {
            clearTimeout(guard);
            void started;
          }
        };
        if (key) {
          await withApiKey(
            { id: key.id, token: key.token, provider: key.provider },
            undefined,
            run
          );
        } else {
          await run();
        }
      })
    );
  }

  // Drain in-memory usage counter before Vercel kills the lambda.
  // Otherwise the last batch of recordApiCall() increments — up to
  // RETESTS_PER_HOUR × oracle calls — silently disappears.
  await flushUsage();

  return NextResponse.json(result);
}

export const GET = POST;
