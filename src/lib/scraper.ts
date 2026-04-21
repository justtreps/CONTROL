import { prisma } from "@/lib/prisma";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";

export const CHECKPOINTS = [
  { name: "T+5min", ageMinutes: 5 },
  { name: "T+30min", ageMinutes: 30 },
  { name: "T+1h", ageMinutes: 60 },
  { name: "T+6h", ageMinutes: 360 },
  { name: "T+24h", ageMinutes: 1440 },
  { name: "T+7d", ageMinutes: 7 * 24 * 60 },
] as const;

export const FINAL_CHECKPOINT = "T+7d";

// Process up to this many orders per cron tick. Bumped from 50 to 200
// so the fetch covers the whole open-order set in one invocation.
// Combined with the "hasPendingWork" filter below, we no longer
// starve recently-placed orders when the top 50 are all fully
// measured orders waiting on T+7d.
const MAX_ORDERS_PER_TICK = 200;

// Fire this many snapshot calls in parallel. Matches the pattern
// used in seeds-health-check — 4-5× throughput vs the old serial
// loop, comfortably under RapidAPI's practical rate limits.
const SNAPSHOT_CONCURRENCY = 8;

export type ScraperResult = {
  ordersSeen: number;
  ordersWithWork: number;
  ordersScanned: number;
  measurements: number;
  errors: Array<{ orderId: number; reason: string }>;
};

export async function runScraper(
  opts: { maxOrders?: number } = {}
): Promise<ScraperResult> {
  const maxOrders = opts.maxOrders ?? MAX_ORDERS_PER_TICK;
  const result: ScraperResult = {
    ordersSeen: 0,
    ordersWithWork: 0,
    ordersScanned: 0,
    measurements: 0,
    errors: [],
  };

  // Pull all open orders (not yet final), cap at maxOrders. With 200
  // default and ~100 open orders in practice, this fetches everyone
  // every tick — no starvation on any individual order.
  const openOrders = await prisma.testOrder.findMany({
    where: {
      measurements: { none: { checkpoint: FINAL_CHECKPOINT } },
    },
    include: {
      service: true,
      testAccount: true,
      measurements: { select: { checkpoint: true } },
    },
    orderBy: { placedAt: "asc" },
    take: maxOrders,
  });

  result.ordersSeen = openOrders.length;

  // Filter to orders with at least one overdue checkpoint. Orders
  // that have collected everything but T+7d (and aren't old enough
  // for T+7d yet) are naturally skipped here; no cycles wasted.
  const withWork = openOrders.filter((order) => {
    const ageMin = (Date.now() - order.placedAt.getTime()) / 60000;
    const done = new Set(order.measurements.map((m) => m.checkpoint));
    return CHECKPOINTS.some(
      (cp) => ageMin >= cp.ageMinutes && !done.has(cp.name)
    );
  });
  result.ordersWithWork = withWork.length;

  // Parallel sweep in batches of SNAPSHOT_CONCURRENCY. Each snapshot
  // is an independent RapidAPI call + DB write, so Promise.all is
  // safe (no shared mutation of fields per-order).
  for (let i = 0; i < withWork.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = withWork.slice(i, i + SNAPSHOT_CONCURRENCY);
    await Promise.all(
      batch.map((order) => scanOneOrder({ order, result }))
    );
  }

  return result;
}

async function scanOneOrder({
  order,
  result,
}: {
  order: {
    id: number;
    placedAt: Date;
    service: { platform: string };
    testAccount: { username: string; userId: string };
    measurements: Array<{ checkpoint: string }>;
  };
  result: ScraperResult;
}): Promise<void> {
  const ageMin = (Date.now() - order.placedAt.getTime()) / 60000;
  const done = new Set(order.measurements.map((m) => m.checkpoint));
  const due = CHECKPOINTS.filter(
    (cp) => ageMin >= cp.ageMinutes && !done.has(cp.name)
  );

  if (due.length === 0) return; // defensive; prefilter already excluded these

  result.ordersScanned++;

  try {
    const snap = await fetchFollowerSnapshot(
      order.service.platform as Platform,
      order.testAccount.username,
      order.testAccount.userId
    );

    for (const cp of due) {
      await prisma.measurement.create({
        data: {
          testOrderId: order.id,
          checkpoint: cp.name,
          actualCount: snap.count,
          realismData: snap.realismData,
          realismScore: snap.realismScore,
        },
      });
      result.measurements++;
    }

    if (due.some((cp) => cp.name === FINAL_CHECKPOINT)) {
      await prisma.testOrder.update({
        where: { id: order.id },
        data: { completedAt: new Date() },
      });
    }
  } catch (e) {
    result.errors.push({
      orderId: order.id,
      reason: (e as Error).message.slice(0, 200),
    });
  }
}
