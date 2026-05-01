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
import {
  fetchOracleFor,
  fetchPostOracle,
  pickPostMetric,
  type PostMetric,
} from "@/lib/pool/oracle";
import {
  onMeasurementWritten,
  onTestCompleted,
} from "@/lib/catalogue/lifecycle";
import { withApiKey, flushUsage } from "@/lib/rapidapi/key-manager";
import {
  isKeyTripped,
  noteKeyOutcome,
} from "@/lib/rapidapi/circuit-breaker";
import { getSystemToggles } from "@/lib/system/toggles";

// ── Tuning knobs ────────────────────────────────────────────────
// Polling cadence is now operator-configurable via SystemToggle
// (default 10 min — see schema). Read once per runPoller call.
// Fallback constant covers the legacy/empty-row case.
const FALLBACK_POLL_INTERVAL_MIN = 10;
const TRANSIENT_RETRY_MS = 60 * 60_000;           // 1 h retry on oracle error
const FINALIZE_AGE_MS = 7 * 24 * 60 * 60_000;     // 7-day sunset

// 500 was too aggressive — production showed every tick hitting
// the 300s maxDuration with 0 measurements written. Even at 2-3 s
// per oracle call × 500 / 8 concurrency = 187 s baseline, but
// p95 timeouts (25 s × 25 % of polls) push expected wall time
// past 300 s. Cut to 100 / tick → expected wall ~40-60 s steady,
// ~120 s worst case. Backlog drains slower (100/h vs 500/h) but
// it actually completes per tick instead of getting killed
// mid-batch with no progress persisted.
// MAX_ORDERS_PER_TICK + POLL_CONCURRENCY auto-tune from
// pollIntervalMinutes via computeTickSizing(). Fast cadence ⇒
// bigger batch + more workers (drain rate matches firing rate),
// slow cadence ⇒ smaller batch + fewer workers (RapidAPI headroom
// for other crons).

function computeTickSizing(intervalMin: number): {
  maxOrders: number;
  concurrency: number;
} {
  // 10-min cadence with N running orders means every order needs
  // to be polled in each 10-min window. With ~1700 running orders
  // and a /10 cron, that's 1700 polls per 10-min tick. The
  // RapidAPI aggregate cap (2 × 100 = 200 RPM = 2000/10min) sets
  // the actual ceiling; concurrency 16 + cap 500 lets us absorb
  // a one-time backlog spike (drain in 4 ticks) and steady-state
  // sees most ticks return early because the cap dwarfs the
  // typical due-count.
  if (intervalMin <= 30) return { maxOrders: 500, concurrency: 16 };
  if (intervalMin <= 60) return { maxOrders: 200, concurrency: 12 };
  return { maxOrders: 60, concurrency: 8 };
}

// Tick budget — exit cleanly if we approach Vercel's 300 s
// maxDuration so the lambda returns a payload (with audit log)
// instead of dying on a 504.
const TICK_BUDGET_MS = 250_000;

// Stale-order fallback: TestOrders whose nextPollAt is older than
// this without progress get auto-finalised as completed_partial.
// Prevents the queue from growing indefinitely if a backlog can't
// drain.
const STALE_NEXT_POLL_MS = 24 * 60 * 60_000;

// Hard per-poll wall-clock cap. Multiple layers stack:
// fetchOracleFor (~30 s with timeout), measurement upsert,
// lifecycle hook updates, testOrder.update. Local profile
// shows ghost path = 1-3 s, success path = 3-5 s. Production
// observed 60 s wasn't enough — Vercel sin1 → RapidAPI tail
// latency stacks past it. 120 s gives the legit path room and
// catches genuinely stuck calls.
const PER_POLL_HARD_CAP_MS = 120_000;

// Per-key circuit breaker is in lib/rapidapi/circuit-breaker.ts —
// shared with scraper/sweep/campaign so a degraded key skipped by
// one job is automatically avoided by the others.

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
  // Engagement-flow fields. targetType='post' means this order was
  // placed against a TestPost (likes/views/etc.), and the poller must
  // read post-level counts via fetchPostOracle instead of the parent
  // account's followers. testPost is null for follower-flow rows.
  targetType: string;
  targetMetric: string | null;
  testPostId: number | null;
  testPost: { mediaId: string; mediaUrl: string } | null;
  service: { platform: string; serviceType: string };
  testAccount: { userId: string };
};

export async function runPoller(): Promise<PollerResult> {
  const result: PollerResult = {
    ordersPolled: 0,
    ordersFinalised: 0,
    ordersRescheduledOnError: 0,
    errors: [],
  };

  const tickStart = Date.now();
  const now = new Date();
  const toggles = await getSystemToggles().catch(() => null);
  const pollIntervalMin =
    toggles?.pollIntervalMinutes ?? FALLBACK_POLL_INTERVAL_MIN;
  const sizing = computeTickSizing(pollIntervalMin);
  const MAX_ORDERS_PER_TICK = sizing.maxOrders;
  const POLL_CONCURRENCY = sizing.concurrency;

  // Fallback for orders that have aged past STALE_NEXT_POLL_MS
  // without progress — finalise them as completed_partial so the
  // queue doesn't grow indefinitely when the poller falls behind.
  // Cheap one-shot updateMany before the regular drain.
  const staleCutoff = new Date(now.getTime() - STALE_NEXT_POLL_MS);
  const stale = await prisma.testOrder.updateMany({
    where: { status: "running", nextPollAt: { lt: staleCutoff } },
    data: {
      status: "completed_partial",
      completedAt: now,
      nextPollAt: null,
    },
  });
  if (stale.count > 0) {
    console.log(
      `[testbot-poll] auto-finalised ${stale.count} stale orders ` +
        `(nextPollAt > 24 h ago) as completed_partial`
    );
  }

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
      targetType: true,
      targetMetric: true,
      testPostId: true,
      testPost: { select: { mediaId: true, mediaUrl: true } },
      service: { select: { platform: true, serviceType: true } },
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
  let budgetExceeded = false;
  // Filter out tripped keys at the start; if all keys are tripped,
  // we still have a fallback path (key === null → uses env var).
  const usableKeys = activeKeys.filter((k) => !isKeyTripped(k.id));
  if (usableKeys.length < activeKeys.length) {
    console.log(
      `[testbot-poll] circuit breaker: ${activeKeys.length - usableKeys.length}/${activeKeys.length} keys cooling down`
    );
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < POLL_CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (true) {
          // Tick-level budget — every worker checks before pulling
          // another order. Once one hits the budget, all workers
          // wind down within their current poll.
          if (Date.now() - tickStart > TICK_BUDGET_MS) {
            budgetExceeded = true;
            return;
          }
          const idx = cursor++;
          if (idx >= orders.length) return;
          const o = orders[idx];
          const key = usableKeys.length
            ? usableKeys[idx % usableKeys.length]
            : null;
          const pollStart = Date.now();
          let pollFailed = false;
          // Promise.race timeout — prevents a single hang from
          // taking down the whole worker. The losing branch resolves
          // and we continue to the next order; the hung branch keeps
          // running in the background (it'll never fire DB writes
          // since fetch already aborted, just a leaked microtask).
          const hardTimeout = new Promise<void>((resolve) =>
            setTimeout(resolve, PER_POLL_HARD_CAP_MS),
          );
          const pollWork = key
            ? withApiKey(
                { id: key.id, token: key.token, provider: key.provider },
                undefined,
                () => pollOne(o, result, pollIntervalMin),
              )
            : pollOne(o, result, pollIntervalMin);
          await Promise.race([
            pollWork.catch((e) => {
              pollFailed = true;
              result.errors.push({
                orderId: o.id,
                reason: `pollOne_throw: ${(e as Error).message.slice(0, 80)}`,
              });
            }),
            hardTimeout,
          ]);
          // Detect hard-cap timeout — if elapsed >= cap and the poll
          // didn't bump ordersPolled, we lost the worker for this
          // order and need to mark it as a failure for the breaker.
          const hitHardCap = Date.now() - pollStart >= PER_POLL_HARD_CAP_MS;
          if (hitHardCap) {
            pollFailed = true;
            result.errors.push({
              orderId: o.id,
              reason: `hard_cap_${PER_POLL_HARD_CAP_MS}ms`,
            });
          }
          // Per-poll timing observation — the audit log surfaces
          // the slow-tail. >10 s = a hang the AbortSignal didn't catch.
          const elapsed = Date.now() - pollStart;
          if (elapsed > 10_000) {
            console.warn(
              `[testbot-poll] slow poll TO#${o.id} ${elapsed}ms key#${key?.id ?? "env"}`
            );
          }
          // Circuit breaker bookkeeping per ALS-key.
          if (key) noteKeyOutcome(key.id, elapsed, pollFailed);
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
  const elapsedMs = Date.now() - tickStart;
  console.log(
    `[testbot-poll] interval=${pollIntervalMin}min cap=${MAX_ORDERS_PER_TICK} ` +
      `inspected=${orders.length} polled=${result.ordersPolled} ` +
      `finalised=${result.ordersFinalised} ` +
      `rescheduledOnError=${result.ordersRescheduledOnError} ` +
      `errors=${result.errors.length} elapsed=${elapsedMs}ms ` +
      `${budgetExceeded ? "BUDGET_EXCEEDED" : "ok"}`
  );

  return result;
}

async function pollOne(
  order: OrderRow,
  result: PollerResult,
  pollIntervalMin: number,
): Promise<void> {
  result.ordersPolled++;
  const t0 = Date.now();
  const log = (stage: string) => {
    const ms = Date.now() - t0;
    if (ms > 1000) console.log(`[pollOne TO#${order.id}] ${stage} t=${ms}ms`);
  };

  // Branch on targetType: follower flow reads parent's followerCount,
  // engagement flow reads the assigned post's likes/views/etc. Both
  // route through the same Measurement upsert below.
  const isEngagement = order.targetType === "post";
  let currentCount: number;

  if (isEngagement) {
    if (!order.testPost || !order.targetMetric) {
      // Schema invariant: targetType='post' implies both fields set.
      // Defensive — if a row slipped through with the legacy shape
      // we mark it as misplaced and move on so it doesn't burn
      // RapidAPI calls forever.
      await prisma.testOrder.update({
        where: { id: order.id },
        data: {
          status: "aborted_misplaced",
          completedAt: new Date(),
          nextPollAt: null,
          abortReason: "engagement_row_missing_post_or_metric",
        },
      });
      result.ordersFinalised++;
      return;
    }
    let postOracle;
    try {
      postOracle = await fetchPostOracle(
        order.service.platform,
        order.testAccount.userId,
        order.testPost.mediaId,
      );
      log("post_oracle_done");
    } catch (e) {
      await rescheduleOnError(order.id, (e as Error).message, result);
      return;
    }
    if (!postOracle.ok) {
      await rescheduleOnError(order.id, postOracle.message, result);
      return;
    }
    const metricCount = pickPostMetric(
      postOracle,
      order.targetMetric as PostMetric,
    );
    if (metricCount === null) {
      // Provider stopped exposing this metric (rare — IG sometimes
      // drops view_count from older posts). Reschedule in 1h and
      // hope it comes back; not worth aborting the test.
      await rescheduleOnError(
        order.id,
        `metric_unavailable:${order.targetMetric}`,
        result,
      );
      return;
    }
    currentCount = metricCount;
  } else {
    let oracle;
    try {
      oracle = await fetchOracleFor(
        order.service.platform,
        order.testAccount.userId
      );
      log("oracle_done");
    } catch (e) {
      // Unexpected throw (network glitch, key switch mid-call,
      // etc.) — reschedule in 1 h and log. We don't cascade to
      // abort because a 12 h delay is plenty to absorb transients.
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

    currentCount = oracle.followerCount;
  }
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
  log("measurement_upsert");

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
  log("lifecycle_done");

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

  // Add a small jitter (±20 s) so a wave of orders that became
  // due at the same minute don't all re-fire at the same minute
  // next interval — protects the rate limiter from a thundering
  // herd on each cadence multiple.
  const jitterMs = Math.floor((Math.random() - 0.5) * 40_000);
  await prisma.testOrder.update({
    where: { id: order.id },
    data: {
      lastHealthCheckAt: new Date(),
      nextPollAt: new Date(
        Date.now() + pollIntervalMin * 60_000 + jitterMs,
      ),
    },
  });
  log("done");

  // Inline rescoreSingleService was the dominant cost in production
  // pollOne — every call does a full cohort scan
  // (prisma.service.findMany over all active polled services
  // ≈ 3000 rows) to compute the cost percentile. With 30 polls per
  // tick that's 30 × ~5 s = 150 s of rescore alone, pushing pollOne
  // past the 60 s hard cap and producing 0 measurements. The
  // every-10-min scoring cron rescores everyone anyway, so dropping
  // the inline call costs at most a 10 min lag on the dashboard
  // while restoring the poller's throughput. Worth the trade.
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
  // Inline rescore dropped — see the rationale on the polling
  // path. Same trade-off here: the every-10-min scoring cron
  // catches up; finaliseOrder does ≤30/h of these so the
  // bookkeeping cost wasn't huge, but consistency with the polling
  // path matters more than the small dashboard-lag improvement.
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
