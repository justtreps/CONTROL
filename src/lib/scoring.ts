import { prisma } from "@/lib/prisma";
import { consumeCompletedAssignments } from "@/lib/pool/assign";
import type { Measurement, TestOrder } from "@prisma/client";

type OrderWithMeasurements = TestOrder & { measurements: Measurement[] };

export type OrderScore = {
  orderId: number;
  completion: number;
  realism: number;
  speed: number;
  drop: number;
  final: number;
  hasSevenDay: boolean;
  hasCompleted: boolean;
};

const SPEED_BUCKETS: Array<[number, number]> = [
  [5, 100],
  [30, 90],
  [120, 75],
  [24 * 60, 50],
  [72 * 60, 25],
];

function speedScore(deliveryMinutes: number | null): number {
  if (deliveryMinutes === null) return 0;
  for (const [threshold, score] of SPEED_BUCKETS) {
    if (deliveryMinutes <= threshold) return score;
  }
  return 0;
}

export function computeOrderScore(order: OrderWithMeasurements): OrderScore {
  const measurementsSorted = [...order.measurements].sort(
    (a, b) => a.checkedAt.getTime() - b.checkedAt.getTime()
  );

  const postBaseline = measurementsSorted.filter((m) => m.checkpoint !== "T+0");
  const all = measurementsSorted;

  const peakCount =
    all.length === 0
      ? order.baselineCount
      : Math.max(...all.map((m) => m.actualCount));

  const delivered = Math.max(0, peakCount - order.baselineCount);
  const completion = Math.min(1, delivered / Math.max(1, order.targetQuantity));

  const realism =
    postBaseline.length > 0
      ? postBaseline.reduce((acc, m) => acc + (m.realismScore ?? 0), 0) /
        postBaseline.length
      : 0;

  const targetReached = postBaseline.find(
    (m) => m.actualCount - order.baselineCount >= order.targetQuantity * 0.95
  );
  const deliveryMinutes = targetReached
    ? (targetReached.checkedAt.getTime() - order.placedAt.getTime()) / 60000
    : null;
  const speed = speedScore(deliveryMinutes);

  const sevenDay = postBaseline.find((m) => m.checkpoint === "T+7d");
  let drop = 100;
  if (sevenDay && peakCount > order.baselineCount) {
    const netPeak = peakCount - order.baselineCount;
    const netAtJ7 = Math.max(0, sevenDay.actualCount - order.baselineCount);
    const dropRatePct = ((netPeak - netAtJ7) / netPeak) * 100;
    drop = Math.max(0, 100 - dropRatePct * 5);
  }

  const final = completion * (realism * 0.4 + speed * 0.3 + drop * 0.3);

  return {
    orderId: order.id,
    completion,
    realism,
    speed,
    drop,
    final,
    hasSevenDay: Boolean(sevenDay),
    hasCompleted: deliveryMinutes !== null,
  };
}

export type ScoringResult = {
  servicesScored: number;
  servicesSkipped: number;
  rowsWritten: number;
  accountsConsumedByMeasurement: number;
  accountsConsumedByTimeout: number;
};

const MOVING_AVG_WINDOW = 30;

export async function runScoringEngine(): Promise<ScoringResult> {
  const result: ScoringResult = {
    servicesScored: 0,
    servicesSkipped: 0,
    rowsWritten: 0,
    accountsConsumedByMeasurement: 0,
    accountsConsumedByTimeout: 0,
  };

  // Pre-pass: flip assigned → consumed for any account whose test
  // has progressed past the T+0 baseline (or been stuck for 48h+).
  // Runs here instead of dedicated cron because scoring is the
  // natural "end-of-test" signal, and it fires every 10 min anyway.
  const consumed = await consumeCompletedAssignments();
  result.accountsConsumedByMeasurement = consumed.byMeasurement;
  result.accountsConsumedByTimeout = consumed.byTimeout;

  const services = await prisma.service.findMany({
    where: { active: true },
    select: { id: true },
  });

  for (const { id: serviceId } of services) {
    const orders = await prisma.testOrder.findMany({
      where: {
        serviceId,
        measurements: { some: { checkpoint: { not: "T+0" } } },
      },
      include: { measurements: true },
      orderBy: { placedAt: "desc" },
      take: MOVING_AVG_WINDOW,
    });

    if (orders.length === 0) {
      result.servicesSkipped++;
      continue;
    }

    const scores = orders.map(computeOrderScore);

    const avg = (pick: (s: OrderScore) => number) =>
      scores.reduce((acc, s) => acc + pick(s), 0) / scores.length;

    await prisma.serviceScore.create({
      data: {
        serviceId,
        currentScore: avg((s) => s.final),
        completionFactor: avg((s) => s.completion),
        realismScore: avg((s) => s.realism),
        speedScore: avg((s) => s.speed),
        dropScore: avg((s) => s.drop),
      },
    });

    result.servicesScored++;
    result.rowsWritten++;
  }

  return result;
}
