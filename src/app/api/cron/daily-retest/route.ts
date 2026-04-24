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
import { acquireKeyForNewJob, withApiKey } from "@/lib/rapidapi/key-manager";
import type { Service } from "@prisma/client";

// 200 tests/hour = 24 * 200 = 4800/day ceiling. With ~1000
// MONITORED services at steady state we can retest each one ~4×/
// day; at ~3000 MONITORED we retest each ~1.5×/day. That matches
// the daily-retest spec (once per 24h per service).
const RETESTS_PER_HOUR = 200;
const PER_TEST_WALL_MS_BUDGET = 10_000;
const CONCURRENCY = 5;

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

  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);

  // Candidates with lifecycleStatus=MONITORED whose service was
  // last tested ≥24h ago (or never). Group by service so each
  // service is retested once per tick even if it's a candidate
  // for multiple products.
  const cands = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: "MONITORED",
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

  return NextResponse.json(result);
}

export const GET = POST;
