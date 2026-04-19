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

export type ScraperResult = {
  ordersSeen: number;
  ordersScanned: number;
  measurements: number;
  errors: Array<{ orderId: number; reason: string }>;
};

export async function runScraper(
  opts: { maxOrders?: number } = {}
): Promise<ScraperResult> {
  const maxOrders = opts.maxOrders ?? 50;
  const result: ScraperResult = {
    ordersSeen: 0,
    ordersScanned: 0,
    measurements: 0,
    errors: [],
  };

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

  for (const order of openOrders) {
    const ageMin = (Date.now() - order.placedAt.getTime()) / 60000;
    const done = new Set(order.measurements.map((m) => m.checkpoint));

    const due = CHECKPOINTS.filter(
      (cp) => ageMin >= cp.ageMinutes && !done.has(cp.name)
    );

    if (due.length === 0) continue;

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
      result.errors.push({ orderId: order.id, reason: (e as Error).message });
    }
  }

  return result;
}
