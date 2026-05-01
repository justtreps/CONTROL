// Live cadence + RapidAPI capacity probe for the /config polling
// section. UI polls this every few seconds while the operator is
// adjusting the slider so they see the impact preview update in
// real time.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getSystemToggles,
  DEFAULT_POLL_INTERVAL_MIN,
} from "@/lib/system/toggles";

export const dynamic = "force-dynamic";

export async function GET() {
  const [toggles, runningCount, activeKeys] = await Promise.all([
    getSystemToggles(),
    prisma.testOrder.count({ where: { status: "running" } }),
    prisma.rapidApiKey.findMany({
      where: { provider: "instagram", status: "active" },
      select: { rateLimitPerMin: true },
    }),
  ]);

  const pollInterval =
    (toggles as { pollIntervalMinutes?: number }).pollIntervalMinutes ??
    DEFAULT_POLL_INTERVAL_MIN;

  // RapidAPI aggregate ceiling.
  const aggregateRpm = activeKeys.reduce(
    (a, k) => a + (k.rateLimitPerMin ?? 85),
    0,
  );
  const aggregateRph = aggregateRpm * 60;

  // Estimated polls / h at the current cadence.
  const estimatedPollsPerHour =
    pollInterval > 0
      ? Math.round((runningCount * 60) / pollInterval)
      : 0;

  // Saturation = polls / capacity. Verdict bands match the alert
  // detector so the same colour shows on /config and /alertes.
  const saturation = aggregateRph > 0 ? estimatedPollsPerHour / aggregateRph : 0;
  let verdict: "OK" | "AU LIMITE" | "DÉPASSEMENT";
  if (saturation < 0.7) verdict = "OK";
  else if (saturation < 0.95) verdict = "AU LIMITE";
  else verdict = "DÉPASSEMENT";

  return NextResponse.json({
    pollIntervalMinutes: pollInterval,
    runningOrders: runningCount,
    estimatedPollsPerHour,
    activeKeys: activeKeys.length,
    aggregateRpm,
    aggregateRph,
    saturation: Math.round(saturation * 1000) / 10, // %, 1 decimal
    verdict,
  });
}
