// Adaptive poller for in-flight TestOrders.
//
// Replaces the old fixed-checkpoint scraper (T+5/30/1h/6h/24h/7d).
// Every tick does THREE things:
//   1. Re-fetch the target via the pool oracle — mid-test health check.
//   2. If the target died, abort + auto-retry on the same service
//      with a fresh target (chained via TestOrder.retriedFrom).
//   3. If alive, write a Measurement (+ TestPoll audit row) and
//      schedule the next poll with an adaptive interval:
//         delta > 0         → shrink interval × 0.7 toward the 5min floor
//         delta = 0 for 3+  → double it toward the 4h ceiling
//         delta = 0 for 6+  → capped at 4h
//      Adaptive behaviour can be disabled via
//      SystemToggle.adaptivePollingEnabled — in which case every
//      order runs on a fixed 30min cadence (safe default).
//
// Finalise conditions:
//   • delivered >= targetQuantity  → status='completed'
//   • age ≥ 7 days                 → status='completed' (final signal)
//
// Cost note: every retry is a fresh BulkMedya order. The UI surfaces
// retry chains + a per-service "bulkmedya orders placed" counter so
// the operator sees the financial impact.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchOracleFor, type OracleResult } from "@/lib/pool/oracle";
import { placeOrder } from "@/lib/bulkmedya";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";
import {
  pickAndAssignAccount,
  pickAndAssignPost,
  invalidateAccount,
  releasePost,
} from "@/lib/pool/assign";
import { getSystemToggles } from "@/lib/system/toggles";

// ── Tuning knobs ────────────────────────────────────────────────
const MIN_INTERVAL_MS = 5 * 60_000;      // 5 min — floor when delivery is moving
const MAX_INTERVAL_MS = 4 * 60 * 60_000; // 4 h  — ceiling on stagnation
const FIXED_INTERVAL_MS = 30 * 60_000;   // 30 min — kill-switch fallback
const SHRINK_FACTOR = 0.7;               // delta > 0 → next = current * 0.7
const GROW_FACTOR = 2;                   // delta = 0 × 3 → next = current * 2
const ZERO_STREAK_TO_GROW = 3;           // grow after N consecutive zero deltas
const ZERO_STREAK_CAP = 6;               // cap interval at max after 6 zeros
const FINALIZE_AGE_MS = 7 * 24 * 60 * 60_000; // 7-day sunset
const MAX_RETRY_DEPTH = 3;               // TestOrder.retryCount ceiling

// One tick's slice — keep it bounded so we finish within 60s cron.
const MAX_ORDERS_PER_TICK = 150;
const POLL_CONCURRENCY = 6;

export type AdaptivePollingState = {
  nextPollAt: string; // ISO
  currentIntervalMs: number;
  consecutiveZeroDeltas: number;
};

export type PollerResult = {
  ordersPolled: number;
  ordersFinalised: number;
  targetsDied: number;
  retriesPlaced: number;
  retriesSkipped: number;
  errors: Array<{ orderId: number; reason: string }>;
};

export function isPollingStateShape(v: unknown): v is AdaptivePollingState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.nextPollAt === "string" &&
    typeof o.currentIntervalMs === "number" &&
    typeof o.consecutiveZeroDeltas === "number"
  );
}

export function initialPollingState(): AdaptivePollingState {
  // Start on the MIN interval so the first real poll fires 5 min
  // after the order is placed — fast enough to catch instant-start
  // providers, slow enough to avoid a RapidAPI burst right after
  // placement.
  return {
    nextPollAt: new Date(Date.now() + MIN_INTERVAL_MS).toISOString(),
    currentIntervalMs: MIN_INTERVAL_MS,
    consecutiveZeroDeltas: 0,
  };
}

function nextInterval({
  currentMs,
  delta,
  streak,
  adaptive,
}: {
  currentMs: number;
  delta: number;
  streak: number;
  adaptive: boolean;
}): { nextMs: number; newStreak: number } {
  if (!adaptive) {
    // Fixed cadence when the kill switch is off.
    return { nextMs: FIXED_INTERVAL_MS, newStreak: 0 };
  }
  if (delta > 0) {
    // Delivery in progress — shrink toward the floor.
    return {
      nextMs: Math.max(MIN_INTERVAL_MS, Math.round(currentMs * SHRINK_FACTOR)),
      newStreak: 0,
    };
  }
  // delta == 0 — grow the interval once the streak hits the threshold.
  const newStreak = streak + 1;
  if (newStreak >= ZERO_STREAK_CAP) {
    return { nextMs: MAX_INTERVAL_MS, newStreak };
  }
  if (newStreak >= ZERO_STREAK_TO_GROW) {
    return {
      nextMs: Math.min(MAX_INTERVAL_MS, Math.round(currentMs * GROW_FACTOR)),
      newStreak,
    };
  }
  // Keep the same interval until we hit the streak threshold.
  return { nextMs: currentMs, newStreak };
}

// Classify the oracle result into a single target-status label used
// by TestPoll + the dead-target branch of the poller.
export type TargetStatus = "ok" | "deleted" | "private" | "banned" | "error";

function targetStatus(oracle: OracleResult): TargetStatus {
  if (oracle.ok) return oracle.isPrivate ? "private" : "ok";
  if (oracle.reason === "ghost") {
    // "Banned" vs "deleted" disambiguation is weak — RapidAPI returns
    // the same 404 shape for both. We bucket them as 'deleted' unless
    // the upstream message mentions "banned"/"suspended" explicitly.
    const msg = oracle.message.toLowerCase();
    if (/\b(banned|suspended|terminated)\b/.test(msg)) return "banned";
    return "deleted";
  }
  return "error";
}

// ── Main entry ─────────────────────────────────────────────────

export async function runAdaptivePoller(): Promise<PollerResult> {
  const result: PollerResult = {
    ordersPolled: 0,
    ordersFinalised: 0,
    targetsDied: 0,
    retriesPlaced: 0,
    retriesSkipped: 0,
    errors: [],
  };

  const toggles = await getSystemToggles();
  const adaptive = toggles.adaptivePollingEnabled;
  const now = Date.now();

  // Pick due orders. We accept both `status=running` with a polling
  // state whose nextPollAt is reached AND legacy orders without a
  // pollingState (seeded by the old testbot flow): the latter get a
  // fresh state on first visit.
  const due = await prisma.testOrder.findMany({
    where: {
      status: "running",
      OR: [
        { pollingState: { equals: Prisma.DbNull } },
        // JSON-path filter: where pollingState.nextPollAt <= now-iso.
        // Prisma doesn't expose JSON path ops in a typed way for all
        // providers, so we do a coarse filter (any state set) + a
        // per-row gate below.
        { pollingState: { not: Prisma.DbNull } },
      ],
    },
    include: {
      service: { select: { platform: true } },
      testAccount: { select: { id: true, userId: true, username: true } },
    },
    orderBy: { placedAt: "asc" },
    take: MAX_ORDERS_PER_TICK,
  });

  const dueNow = due.filter((o) => {
    const state = isPollingStateShape(o.pollingState) ? o.pollingState : null;
    if (!state) return true; // legacy row — poll immediately
    return Date.parse(state.nextPollAt) <= now;
  });

  for (let i = 0; i < dueNow.length; i += POLL_CONCURRENCY) {
    const batch = dueNow.slice(i, i + POLL_CONCURRENCY);
    await Promise.all(
      batch.map((o) =>
        pollOne({ order: o, adaptive, result }).catch((e) => {
          result.errors.push({
            orderId: o.id,
            reason: (e as Error).message.slice(0, 200),
          });
        })
      )
    );
  }

  return result;
}

// ── Per-order tick ──────────────────────────────────────────────

async function pollOne({
  order,
  adaptive,
  result,
}: {
  order: {
    id: number;
    serviceId: number;
    testAccountId: number;
    targetQuantity: number;
    baselineCount: number;
    placedAt: Date;
    retryCount: number;
    pollingState: unknown;
    service: { platform: string };
    testAccount: { id: number; userId: string; username: string };
  };
  adaptive: boolean;
  result: PollerResult;
}): Promise<void> {
  result.ordersPolled++;
  const state = isPollingStateShape(order.pollingState)
    ? order.pollingState
    : initialPollingState();

  // 1. Health check — re-fetch the target via the oracle.
  const oracle = await fetchOracleFor(
    order.service.platform,
    order.testAccount.userId
  );
  const status = targetStatus(oracle);

  // 2. If the target is dead → abort + auto-retry on the same service.
  if (status === "deleted" || status === "banned") {
    await abortOrderAndRetry({
      order,
      reason: `target_${status}`,
      targetStatusForPoll: status,
      adaptive,
      result,
    });
    return;
  }
  // Private flip — treat like a death too. The parent may come back,
  // but mid-test there's no fresh follower flow to observe so we
  // abort + retry with another target.
  if (status === "private") {
    await abortOrderAndRetry({
      order,
      reason: "target_private",
      targetStatusForPoll: status,
      adaptive,
      result,
    });
    return;
  }

  // Oracle error — record the poll but don't mutate state hard; we'll
  // retry next tick with the same interval.
  if (!oracle.ok) {
    await prisma.testPoll.create({
      data: {
        testOrderId: order.id,
        deliveredQty: 0,
        delta: 0,
        targetStatus: status,
        intervalMsBefore: state.currentIntervalMs,
      },
    });
    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        lastHealthCheckAt: new Date(),
        pollingState: {
          // Keep interval stable on transient oracle error — no streak
          // bump, no shrink.
          nextPollAt: new Date(
            Date.now() + state.currentIntervalMs
          ).toISOString(),
          currentIntervalMs: state.currentIntervalMs,
          consecutiveZeroDeltas: state.consecutiveZeroDeltas,
        } as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
    return;
  }

  // 3. Alive — measure the current count and compute delta.
  const currentCount = oracle.followerCount;
  const deliveredQty = Math.max(0, currentCount - order.baselineCount);

  // Last known delivered count — from the most recent TestPoll or
  // (if none) from the baseline.
  const lastPoll = await prisma.testPoll.findFirst({
    where: { testOrderId: order.id },
    orderBy: { polledAt: "desc" },
    select: { deliveredQty: true },
  });
  const prevDelivered = lastPoll?.deliveredQty ?? 0;
  const delta = deliveredQty - prevDelivered;

  // Grab a realism sample alongside the count so the scoring engine
  // has something fresh to read. Cheap (one /followers call) so we
  // keep doing it on every tick.
  let realismScore: number | null = null;
  let realismData: import("@prisma/client").Prisma.InputJsonValue = {};
  try {
    const snap = await fetchFollowerSnapshot(
      order.service.platform as Platform,
      order.testAccount.username,
      order.testAccount.userId
    );
    realismScore = snap.realismScore;
    realismData =
      snap.realismData as unknown as import("@prisma/client").Prisma.InputJsonValue;
  } catch {
    // Sample is best-effort — the health-check + count above is the
    // critical path.
  }

  // Write the poll + a Measurement (unique checkpoint name). The
  // Measurement keeps the scoring pipeline fed; TestPoll is the
  // audit trail.
  const ageMs = Date.now() - order.placedAt.getTime();
  const isSunset = ageMs >= FINALIZE_AGE_MS;
  const isDelivered = deliveredQty >= order.targetQuantity;
  const shouldFinalise = isSunset || isDelivered;

  const checkpointName = shouldFinalise
    ? "T+7d"
    : `poll-${Math.round(ageMs / 60000)}min`;

  await prisma.$transaction([
    prisma.testPoll.create({
      data: {
        testOrderId: order.id,
        deliveredQty,
        delta,
        targetStatus: status,
        intervalMsBefore: state.currentIntervalMs,
      },
    }),
    prisma.measurement.upsert({
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
        realismData,
        realismScore,
      },
      update: {
        actualCount: currentCount,
        realismData,
        realismScore,
      },
    }),
  ]);

  // 4. Advance state + maybe finalise.
  if (shouldFinalise) {
    result.ordersFinalised++;
    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        lastHealthCheckAt: new Date(),
        pollingState: Prisma.JsonNull,
      },
    });
    return;
  }

  const { nextMs, newStreak } = nextInterval({
    currentMs: state.currentIntervalMs,
    delta,
    streak: state.consecutiveZeroDeltas,
    adaptive,
  });

  await prisma.testOrder.update({
    where: { id: order.id },
    data: {
      lastHealthCheckAt: new Date(),
      pollingState: {
        nextPollAt: new Date(Date.now() + nextMs).toISOString(),
        currentIntervalMs: nextMs,
        consecutiveZeroDeltas: newStreak,
      } as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });
}

// ── Abort + retry on dead target ────────────────────────────────

async function abortOrderAndRetry({
  order,
  reason,
  targetStatusForPoll,
  adaptive,
  result,
}: {
  order: {
    id: number;
    serviceId: number;
    testAccountId: number;
    targetQuantity: number;
    placedAt: Date;
    retryCount: number;
    pollingState: unknown;
    service: { platform: string };
    testAccount: { id: number; userId: string };
  };
  reason: string;
  targetStatusForPoll: TargetStatus;
  adaptive: boolean;
  result: PollerResult;
}): Promise<void> {
  result.targetsDied++;

  const state = isPollingStateShape(order.pollingState)
    ? order.pollingState
    : initialPollingState();

  // Log the dying poll + abort the current row. Keep completedAt
  // null (it only lands on happy-path completion) but stamp
  // abortReason + flip TestAccount/TestPost into died_during_test so
  // the pool audit can see the carnage.
  await prisma.testPoll.create({
    data: {
      testOrderId: order.id,
      deliveredQty: 0,
      delta: 0,
      targetStatus: targetStatusForPoll,
      intervalMsBefore: state.currentIntervalMs,
    },
  });

  await prisma.testOrder.update({
    where: { id: order.id },
    data: {
      status: "aborted_target_died",
      abortReason: reason,
      lastHealthCheckAt: new Date(),
      pollingState: Prisma.JsonNull,
    },
  });

  // Flip the pool entities — the account is no longer usable, and
  // any posts attached to it cascade to 'parent_invalid'.
  await invalidateAccount(order.testAccount.id, "died_during_test").catch(
    () => null
  );

  // Cap the retry chain.
  if (order.retryCount >= MAX_RETRY_DEPTH) {
    result.retriesSkipped++;
    return;
  }

  // Pick a fresh target + re-place the BulkMedya order.
  const placed = await placeRetryOrder({
    fromOrderId: order.id,
    serviceId: order.serviceId,
    platform: order.service.platform,
    targetQuantity: order.targetQuantity,
    nextRetryCount: order.retryCount + 1,
    adaptive,
  }).catch((e) => {
    result.errors.push({
      orderId: order.id,
      reason: `retry_failed: ${(e as Error).message.slice(0, 120)}`,
    });
    return null;
  });

  if (placed) result.retriesPlaced++;
  else result.retriesSkipped++;
}

async function placeRetryOrder({
  fromOrderId,
  serviceId,
  platform,
  targetQuantity,
  nextRetryCount,
  adaptive,
}: {
  fromOrderId: number;
  serviceId: number;
  platform: string;
  targetQuantity: number;
  nextRetryCount: number;
  adaptive: boolean;
}): Promise<number | null> {
  // Pick a fresh account from the catalogue-gated pool.
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { poolType: true, bulkmedyaId: true, minQuantity: true },
  });
  if (!service) return null;

  // Placeholder id — the pool helpers stamp assignedTestOrderId for
  // atomic handoff; we patch the real id post-create just like the
  // testbot's attemptPlaceOrder does.
  let poolPick: import("@prisma/client").TestAccount | null = null;
  let postPick:
    | {
        post: import("@prisma/client").TestPost;
        account: import("@prisma/client").TestAccount;
      }
    | null = null;

  if (service.poolType === "engagement_test") {
    postPick = await pickAndAssignPost({
      platform,
      testOrderId: -1,
    }).catch(() => null);
  } else {
    poolPick = await pickAndAssignAccount({
      platform,
      testOrderId: -1,
    }).catch(() => null);
  }

  const account = postPick?.account ?? poolPick;
  if (!account) return null;

  // Baseline read + health check — same as the testbot first-pass
  // does in attemptPlaceOrder.
  const oracle = await fetchOracleFor(platform, account.userId);
  if (!oracle.ok || oracle.isPrivate) {
    // Release + bail. The next poller tick will retry again until
    // MAX_RETRY_DEPTH is reached.
    if (postPick) await releasePost(postPick.post.id);
    return null;
  }

  const targetUrl =
    platform === "instagram"
      ? `https://www.instagram.com/${oracle.username}/`
      : `https://www.tiktok.com/@${oracle.username}`;

  // Honor the same simulated-placement gate as testbot.ts first-pass
  // so a retry during dryRunMode doesn't accidentally spend real
  // BulkMedya budget.
  const toggles = await getSystemToggles();
  const simulated = !toggles.testBotEnabled || toggles.dryRunMode;

  let bulkmedyaOrderId: string;
  if (simulated) {
    bulkmedyaOrderId = `sim-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  } else {
    const placement = await placeOrder({
      service: service.bulkmedyaId,
      link: postPick?.post.mediaUrl ?? targetUrl,
      quantity: targetQuantity,
    });
    if ("error" in placement) {
      if (postPick) await releasePost(postPick.post.id);
      return null;
    }
    bulkmedyaOrderId = String(placement.order);
  }

  const newOrder = await prisma.testOrder.create({
    data: {
      serviceId,
      testAccountId: account.id,
      bulkmedyaOrderId,
      targetQuantity,
      baselineCount: oracle.followerCount,
      status: "running",
      dryRun: simulated,
      retriedFrom: fromOrderId,
      retryCount: nextRetryCount,
      lastHealthCheckAt: new Date(),
      pollingState:
        initialPollingState() as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  // Attach the pool entity to the new order (placeholder -1 → real id).
  if (postPick) {
    await prisma.testPost.update({
      where: { id: postPick.post.id },
      data: { assignedTestOrderId: newOrder.id },
    });
  } else if (poolPick) {
    await prisma.testAccount.update({
      where: { id: poolPick.id },
      data: { assignedTestOrderId: newOrder.id },
    });
  }

  // T+0 baseline measurement.
  await prisma.measurement.create({
    data: {
      testOrderId: newOrder.id,
      checkpoint: "T+0",
      actualCount: oracle.followerCount,
      realismData: {},
      realismScore: null,
    },
  });

  // Bump Service.lastTestedAt for the obsolescence filter.
  await prisma.service.update({
    where: { id: serviceId },
    data: { lastTestedAt: new Date() },
  });

  // Accept the fact that we're also unused-variable-flagging
  // `adaptive` here; it's relevant for future tuning (eg. shorter
  // first-poll on retries when adaptive is on) but currently the
  // caller has already honoured the kill switch.
  void adaptive;

  return newOrder.id;
}

