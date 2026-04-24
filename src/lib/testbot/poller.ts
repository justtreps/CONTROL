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
      targetQuantity: true,
      baselineCount: true,
      placedAt: true,
      service: { select: { platform: true } },
      testAccount: { select: { userId: true } },
    },
    orderBy: { nextPollAt: "asc" },
    take: MAX_ORDERS_PER_TICK,
  });

  for (let i = 0; i < orders.length; i += POLL_CONCURRENCY) {
    const wave = orders.slice(i, i + POLL_CONCURRENCY);
    await Promise.all(wave.map((o) => pollOne(o, result)));
  }

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

  // Checkpoint name stays unique per age so the Measurement
  // upsert's @@unique([testOrderId, checkpoint]) constraint never
  // fires. "T+7d" reserved for the terminal write so the scoring
  // engine's existing 7-day reads keep working.
  const checkpointName = shouldFinalise
    ? "T+7d"
    : `poll-${Math.round(ageMs / 60000)}min`;

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

  if (shouldFinalise) {
    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        lastHealthCheckAt: new Date(),
        nextPollAt: null,
      },
    });
    result.ordersFinalised++;
    return;
  }

  await prisma.testOrder.update({
    where: { id: order.id },
    data: {
      lastHealthCheckAt: new Date(),
      nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS),
    },
  });
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
