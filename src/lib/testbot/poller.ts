// Fixed-cadence poller for in-flight TestOrders.
//
// SMM delivery is paced in hours and days, not minutes — BulkMedya
// spreads followers/likes/views across the lifetime of the order.
// The previous adaptive loop (5 min → 4 h) burned RapidAPI quota
// for no signal: most polls showed delta=0 because nothing had
// been delivered since the last check. We replace it with a
// simple 12 h cadence (2 polls/day × 7 d = 14 polls per order)
// that captures the full delivery curve at ~1/2 the API cost.
//
// Per-order flow — each poll is one RapidAPI oracle call:
//   1. Fetch the target's current count via fetchOracleFor.
//   2. Upsert a Measurement row (actualCount = current count).
//   3. If delivered >= target OR age >= 7 days → status='completed'.
//   4. Otherwise → nextPollAt = now + 12 h.
//
// NO mid-test health check. NO auto-retry on target death. If the
// target dies, the oracle returns ghost/error and we record
// deliveredQty=0 — the order naturally finalises at T+7 d with
// zero measured delivery, which the scoring engine's RULE 1 then
// filters out. This keeps the poller ~80 lines instead of ~500.
//
// Transient oracle errors: reschedule in 1 h instead of 12 h so a
// momentary RapidAPI hiccup doesn't lose half a day of signal.

import { prisma } from "@/lib/prisma";
import { fetchOracleFor } from "@/lib/pool/oracle";
import {
  onMeasurementWritten,
  onTestCompleted,
} from "@/lib/catalogue/lifecycle";
import { withApiKey, flushUsage } from "@/lib/rapidapi/key-manager";

// ── Tuning knobs ────────────────────────────────────────────────
const POLL_INTERVAL_MS = 12 * 60 * 60_000;        // 12 h between normal polls
const TRANSIENT_RETRY_MS = 60 * 60_000;           // 1 h retry on oracle error
const FINALIZE_AGE_MS = 7 * 24 * 60 * 60_000;     // 7-day sunset

// One tick's slice. The hourly cron budget is 60 s — at ~1 s per
// oracle call and concurrency 8, we can comfortably poll 500+
// orders per tick. In practice far fewer will be due since each
// order only becomes due every 12 h.
const MAX_ORDERS_PER_TICK = 500;
const POLL_CONCURRENCY = 8;

export type PollerResult = {
  ordersPolled: number;
  ordersFinalised: number;
  ordersRescheduledOnError: number;
  errors: Array<{ orderId: number; reason: string }>;
};

type OrderRow = {
  id: number;
  serviceId: number;
  targetQuantity: number;
  baselineCount: number;
  placedAt: Date;
  service: { platform: string };
  testAccount: { userId: string };
};

export async function runPoller(): Promise<PollerResult> {
  const result: PollerResult = {
    ordersPolled: 0,
    ordersFinalised: 0,
    ordersRescheduledOnError: 0,
    errors: [],
  };

  const now = new Date();

  // Pull running orders whose next-poll deadline has passed.
  // Orders placed before the refactor have nextPollAt=null — the
  // migration script seeds them with now + 12 h so they slip into
  // the new cadence without a spike.
  const orders = await prisma.testOrder.findMany({
    where: {
      status: "running",
      nextPollAt: { lte: now },
    },
    select: {
      id: true,
      serviceId: true,
      targetQuantity: true,
      baselineCount: true,
      placedAt: true,
      service: { select: { platform: true } },
      testAccount: { select: { userId: true } },
    },
    orderBy: { nextPollAt: "asc" },
    take: MAX_ORDERS_PER_TICK,
  });

  // Round-robin RapidAPI keys per-order. Without this wrap,
  // currentKey() returns null for every poll → every oracle
  // call falls through to the legacy env-var fallback → only
  // one key's quota gets consumed and rate_limiter:legacy
  // saturates while the second active key sits idle.
  const activeKeys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram", status: "active" },
    select: { id: true, token: true, provider: true },
  });

  // Worker-pool model — the previous version used Promise.all per
  // wave, which made every wave block on its slowest pollOne. With
  // RapidAPI's tail-latency profile (most polls 2-3s, occasional
  // 25 s hangs that hit the new fetch timeout), wave-based blocking
  // wasted the budget: 8 fast polls finishing in 3 s sat idle for
  // 22 more seconds waiting on the slow one, instead of starting
  // the next 8. With a worker pool, a hang ties up exactly one
  // worker for 25 s while the other 7 keep pulling new orders.
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < POLL_CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= orders.length) return;
          const o = orders[idx];
          const key = activeKeys.length
            ? activeKeys[idx % activeKeys.length]
            : null;
          if (!key) {
            await pollOne(o, result).catch((e) => {
              result.errors.push({
                orderId: o.id,
                reason: `pollOne_throw: ${(e as Error).message.slice(0, 80)}`,
              });
            });
            continue;
          }
          await withApiKey(
            { id: key.id, token: key.token, provider: key.provider },
            undefined,
            () => pollOne(o, result),
          ).catch((e) => {
            result.errors.push({
              orderId: o.id,
              reason: `pollOne_throw: ${(e as Error).message.slice(0, 80)}`,
            });
          });
        }
      })()
    );
  }
  await Promise.all(workers);

  // recordApiCall() under withApiKey writes into an in-memory
  // pending Map flushed on a 5 s setInterval. Vercel kills the
  // lambda the moment runPoller() returns, so without this explicit
  // flush the LAST batch of usage (potentially hundreds of calls
  // for a 500-order tick) is silently dropped — quotaUsed under-
  // counts and the round-robin LRU stops working as intended.
  await flushUsage();

  // One-line audit log per tick. The previous version was silent,
  // so when the poller stopped advancing orders (eg. all polls
  // hitting oracle errors and rescheduling +1h), there was no
  // signal in the Vercel function logs explaining why.
  console.log(
    `[testbot-poll] inspected=${orders.length} polled=${result.ordersPolled} ` +
      `finalised=${result.ordersFinalised} ` +
      `rescheduledOnError=${result.ordersRescheduledOnError} ` +
      `errors=${result.errors.length}`
  );

  return result;
}

async function pollOne(order: OrderRow, result: PollerResult): Promise<void> {
  result.ordersPolled++;

  let oracle;
  try {
    oracle = await fetchOracleFor(
      order.service.platform,
      order.testAccount.userId
    );
  } catch (e) {
    // Unexpected throw (network glitch, key switch mid-call, etc.) —
    // reschedule in 1 h and log. We don't cascade to abort because
    // a 12 h delay is plenty to absorb transients.
    await rescheduleOnError(order.id, (e as Error).message, result);
    return;
  }

  if (!oracle.ok) {
    // oracle.reason is 'ghost' | 'error'. Either way we don't
    // invalidate the account (pool is managed by health-check cron)
    // and we don't auto-retry. Record the failed read + retry in 1h.
    await rescheduleOnError(order.id, oracle.message, result);
    return;
  }

  const currentCount = oracle.followerCount;
  const deliveredQty = Math.max(0, currentCount - order.baselineCount);
  const ageMs = Date.now() - order.placedAt.getTime();
  const isSunset = ageMs >= FINALIZE_AGE_MS;
  const isDelivered = deliveredQty >= order.targetQuantity;
  const shouldFinalise = isSunset || isDelivered;

  // Checkpoint name reflects WHY this is the terminal measurement,
  // not just "is terminal". A service that delivered fully in 30
  // minutes used to land with checkpoint='T+7d' which lied to the
  // operator about the test age. Now:
  //   • isSunset (age >= 7d, no full delivery)         → "T+7d"
  //   • isDelivered (peak >= target, before 7d sunset) → "completed"
  //   • mid-poll                                       → "poll-{min}min"
  // Scoring engine reads `hasSevenDay` as a boolean flag — having
  // a separate label for early-completion is purely informational,
  // doesn't change the score, but makes the /logs view honest.
  let checkpointName: string;
  if (isSunset) checkpointName = "T+7d";
  else if (isDelivered) checkpointName = "completed";
  else checkpointName = `poll-${Math.round(ageMs / 60000)}min`;

  await prisma.measurement.upsert({
    where: {
      testOrderId_checkpoint: {
        testOrderId: order.id,
        checkpoint: checkpointName,
      },
    },
    create: {
      testOrderId: order.id,
      checkpoint: checkpointName,
      actualCount: currentCount,
      realismData: {},
    },
    update: { actualCount: currentCount },
  });

  // Per-poll qualification — fires on EVERY measurement, not just
  // at finalize. A service that delivers in the first 30 min flips
  // to QUALIFIED right away, doesn't wait for the T+7d sunset.
  // No-ops when deliveredQty <= 0 or service is already QUALIFIED+.
  await onMeasurementWritten({
    serviceId: order.serviceId,
    deliveredQty,
  }).catch((e) => {
    result.errors.push({
      orderId: order.id,
      reason: `lifecycle_qualify: ${(e as Error).message.slice(0, 80)}`,
    });
  });

  if (shouldFinalise) {
    await finaliseOrder(order, deliveredQty, "completed", result);
    return;
  }

  // Stagnation detection — if the last 3 measurements (including
  // this one) show identical actualCount AND age ≥ 24h, the
  // delivery has plateaued. Auto-finalize as 'completed_partial'
  // so the score engine can compute a real (low) value instead of
  // waiting another 4 days for the T+7d sunset.
  if (await isStagnant(order.id, currentCount, ageMs)) {
    await finaliseOrder(order, deliveredQty, "completed_partial", result);
    return;
  }

  await prisma.testOrder.update({
    where: { id: order.id },
    data: {
      lastHealthCheckAt: new Date(),
      nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS),
    },
  });

  // Score lives off the latest test that's been polled at least
  // once. Every poll changes the latest test's state, so every
  // poll potentially changes the service score. Rescore inline,
  // dedupe-protected so we don't bloat ServiceScore.
  try {
    const { rescoreSingleService } = await import("@/lib/scoring");
    await rescoreSingleService(order.serviceId);
  } catch (e) {
    result.errors.push({
      orderId: order.id,
      reason: `rescore_poll: ${(e as Error).message.slice(0, 80)}`,
    });
  }
}

const STAGNATION_MIN_AGE_MS = 24 * 60 * 60_000;
const STAGNATION_REQUIRED_REPEATS = 3;

async function isStagnant(
  testOrderId: number,
  currentCount: number,
  ageMs: number
): Promise<boolean> {
  if (ageMs < STAGNATION_MIN_AGE_MS) return false;
  // Pull the last N measurements (excluding T+0 baseline) for
  // this order, ordered newest-first. We just wrote one this
  // tick so it's included.
  const recent = await prisma.measurement.findMany({
    where: {
      testOrderId,
      checkpoint: { not: "T+0" },
    },
    orderBy: { checkedAt: "desc" },
    take: STAGNATION_REQUIRED_REPEATS,
  });
  if (recent.length < STAGNATION_REQUIRED_REPEATS) return false;
  // All of the last N must equal the current count.
  return recent.every((m) => m.actualCount === currentCount);
}

async function finaliseOrder(
  order: OrderRow,
  deliveredQty: number,
  status: "completed" | "completed_partial",
  result: PollerResult
): Promise<void> {
  // Compare-and-swap on status='running' so two overlapping cron
  // ticks can't both finalise the same order. The previous version
  // used prisma.update by id only — both ticks would succeed, and
  // onTestCompleted/rescoreSingleService would fire twice (which
  // could double-trigger a DEAD lifecycle transition or pollute the
  // ServiceScore stream with two near-identical inserts within the
  // dedupe window).
  const claim = await prisma.testOrder.updateMany({
    where: { id: order.id, status: "running" },
    data: {
      status,
      completedAt: new Date(),
      lastHealthCheckAt: new Date(),
      nextPollAt: null,
    },
  });
  if (claim.count === 0) {
    // Already finalised by another tick — skip the lifecycle/rescore
    // fan-out so we don't fire it twice.
    return;
  }
  // Terminal lifecycle hook (DEAD transitions etc.) — covers both
  // completed and completed_partial.
  await onTestCompleted({
    serviceId: order.serviceId,
    testOrderId: order.id,
    deliveredQty,
  }).catch((e) => {
    result.errors.push({
      orderId: order.id,
      reason: `lifecycle_finalize: ${(e as Error).message.slice(0, 80)}`,
    });
  });
  // Recompute the service's score IMMEDIATELY so the dashboard
  // reflects the new test outcome without waiting for the 10-min
  // scoring cron tick. Best-effort.
  try {
    const { rescoreSingleService } = await import("@/lib/scoring");
    await rescoreSingleService(order.serviceId);
  } catch (e) {
    result.errors.push({
      orderId: order.id,
      reason: `rescore: ${(e as Error).message.slice(0, 80)}`,
    });
  }
  result.ordersFinalised++;
}

async function rescheduleOnError(
  orderId: number,
  reason: string,
  result: PollerResult
): Promise<void> {
  await prisma.testOrder
    .update({
      where: { id: orderId },
      data: {
        lastHealthCheckAt: new Date(),
        nextPollAt: new Date(Date.now() + TRANSIENT_RETRY_MS),
      },
    })
    .catch(() => null);
  result.ordersRescheduledOnError++;
  result.errors.push({ orderId, reason: reason.slice(0, 120) });
}
