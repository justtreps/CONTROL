import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getSystemToggles,
  updateSystemToggles,
  MIN_POLL_INTERVAL_MIN,
  MAX_POLL_INTERVAL_MIN,
} from "@/lib/system/toggles";
import { invalidateDryRunCache } from "@/lib/router";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const t = await getSystemToggles();
  return NextResponse.json({ toggles: t });
}

const patchSchema = z
  .object({
    poolScrapeEnabled: z.boolean().optional(),
    poolHealthcheckEnabled: z.boolean().optional(),
    routingApiEnabled: z.boolean().optional(),
    testBotEnabled: z.boolean().optional(),
    scoringEngineEnabled: z.boolean().optional(),
    workflowExecutorEnabled: z.boolean().optional(),
    dailyRetestEnabled: z.boolean().optional(),
    autoKillDeadServicesEnabled: z.boolean().optional(),
    dailySyncEnabled: z.boolean().optional(),
    dryRunMode: z.boolean().optional(),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_MIN)
      .max(MAX_POLL_INTERVAL_MIN)
      .optional(),
  })
  .strict();

// When the operator changes the polling cadence, restagger every
// running TestOrder's nextPollAt so they don't all queue at the
// new boundary (thundering herd → rate-limit saturation). We
// distribute deadlines uniformly across the new window with a
// ±20 s jitter on top — same pattern the poller uses per-poll.
async function restaggerRunningOrders(intervalMin: number): Promise<number> {
  const running = await prisma.testOrder.findMany({
    where: { status: "running" },
    select: { id: true },
  });
  const windowMs = intervalMin * 60_000;
  // Spread the orders evenly across [now, now + window) so the
  // poller has a steady drain rate instead of N orders all firing
  // at the same minute mark.
  const baseNow = Date.now();
  const updates = running.map((o, i) => {
    const slot = (windowMs * i) / Math.max(1, running.length);
    const jitter = Math.floor((Math.random() - 0.5) * 40_000);
    return prisma.testOrder.update({
      where: { id: o.id },
      data: { nextPollAt: new Date(baseNow + slot + jitter) },
    });
  });
  // Chunked transactions — Postgres params have a 65 535 ceiling
  // and one update is 2 params, so 1 000 / batch is comfortable.
  const BATCH = 1000;
  for (let i = 0; i < updates.length; i += BATCH) {
    await prisma.$transaction(updates.slice(i, i + BATCH));
  }
  return running.length;
}

export async function PATCH(req: Request) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const before = await getSystemToggles();
    const t = await updateSystemToggles(parsed.data);
    if ("dryRunMode" in parsed.data) invalidateDryRunCache();

    // Restagger only when cadence actually changed — flipping a
    // boolean toggle shouldn't bump every running order's poll
    // schedule.
    let restaggered = 0;
    const newInterval = (
      t as { pollIntervalMinutes?: number }
    ).pollIntervalMinutes;
    const oldInterval = (
      before as { pollIntervalMinutes?: number }
    ).pollIntervalMinutes;
    if (
      "pollIntervalMinutes" in parsed.data &&
      typeof newInterval === "number" &&
      newInterval !== oldInterval
    ) {
      restaggered = await restaggerRunningOrders(newInterval);
    }
    return NextResponse.json({ ok: true, toggles: t, restaggered });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
