// CRON_SECRET-gated force-place — runs attemptPlaceOrder against
// a specific Service.id (or bulkmedyaId) right now, bypassing the
// daily-retest queue order. Useful for:
//   1. Validating a single service's placement after a routing fix
//      (post-deploy smoke test).
//   2. Force-placing a small batch of engagement services to seed
//      reliability data after the recovery cohort lands.
//
// Body: { serviceId?: number, bulkmedyaId?: number }
//   Exactly one must be set. bulkmedyaId is more operator-friendly
//   because BulkMedya UI uses that id; serviceId is the internal pk
//   if the operator already has it.
//
// Returns the attemptPlaceOrder outcome shape so the operator can
// see whether the placement landed or hit a known skip reason.
//
// Auth: Bearer CRON_SECRET. Whitelisted in middleware.

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { attemptPlaceOrder } from "@/lib/testbot";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 90;

const bodySchema = z
  .object({
    serviceId: z.number().int().positive().optional(),
    bulkmedyaId: z.number().int().positive().optional(),
    simulated: z.boolean().optional(),
  })
  .refine((d) => d.serviceId !== undefined || d.bulkmedyaId !== undefined, {
    message: "must provide serviceId OR bulkmedyaId",
  });

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { serviceId, bulkmedyaId, simulated: simulatedOverride } = parsed.data;

  const service = serviceId
    ? await prisma.service.findUnique({ where: { id: serviceId } })
    : await prisma.service.findFirst({ where: { bulkmedyaId } });
  if (!service) {
    return NextResponse.json(
      { error: "service_not_found", serviceId, bulkmedyaId },
      { status: 404 },
    );
  }

  // Respect the global dry-run / kill-switch toggles unless caller
  // explicitly overrides — keeps force-place from accidentally
  // burning budget when the operator's flipped dryRunMode on.
  const toggles = await getSystemToggles();
  const simulated =
    simulatedOverride ??
    (!toggles.testBotEnabled || toggles.dryRunMode);

  const t0 = Date.now();
  const outcome = await attemptPlaceOrder({ service, simulated });
  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    serviceId: service.id,
    bulkmedyaId: service.bulkmedyaId,
    serviceType: service.serviceType,
    platform: service.platform,
    simulated,
    outcome,
  });
}

export const GET = POST;
