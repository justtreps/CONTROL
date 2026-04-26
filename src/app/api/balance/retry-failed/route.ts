// Operator clicks "J'AI RECHARGÉ — RELANCER" on the dashboard
// balance card. Two-stage flow:
//
//   1. Pick the cheapest balance-failed service and fire ONE
//      probe placement to validate the balance is actually
//      restored. Cheapest = least wasted spend if balance is
//      still low.
//   2. If the probe lands successfully → spawn (or merge into)
//      a brute-mode ScoringCampaign with all the
//      balance-failed service IDs. The brute-campaign-runner
//      cron drains the queue within minutes.
//   3. If the probe still rejects with a balance error →
//      return 409 with "balance_still_insufficient" so the UI
//      tells the operator to recharge more.
//
// Middleware enforces session auth on /api/balance/*.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listBalanceFailedServiceIds } from "@/lib/balance/retry-budget";
import { testCostUsd } from "@/lib/scoring/test-quantity";
import { placeOrder } from "@/lib/bulkmedya";
import { testQuantityFor } from "@/lib/scoring/test-quantity";

export const maxDuration = 60;

const BALANCE_REGEX = /balance|insufficient|neutral|fund|not enough|low ?bal/i;

export async function POST() {
  const ids = await listBalanceFailedServiceIds();
  if (ids.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_balance_failed_services" },
      { status: 404 }
    );
  }

  // ── 1. Pick cheapest probe target ──────────────────────────
  const services = await prisma.service.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      platform: true,
      bulkmedyaId: true,
      ratePerK: true,
      minQuantity: true,
      maxQuantity: true,
      poolType: true,
    },
  });
  const sorted = services
    .map((s) => ({ s, cost: testCostUsd(s) }))
    .filter((p): p is { s: (typeof services)[number]; cost: number } =>
      p.cost !== null
    )
    .sort((a, b) => a.cost - b.cost);
  if (sorted.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_eligible_probe_target" },
      { status: 404 }
    );
  }
  const probe = sorted[0].s;
  const probeQty = testQuantityFor(probe);
  if (probeQty === null) {
    return NextResponse.json(
      { ok: false, error: "probe_qty_floor_failure" },
      { status: 404 }
    );
  }

  // Pick a pool entity for the probe URL. We don't consume it —
  // probe is a one-off addOrder, no TestOrder row created.
  let probeLink = "";
  const isEngagement = probe.poolType === "engagement_test";
  if (isEngagement) {
    const post = await prisma.testPost.findFirst({
      where: { status: "available", platform: probe.platform },
      orderBy: { firstSeenAt: "asc" },
    });
    if (!post) {
      return NextResponse.json(
        { ok: false, error: "no_pool_entity_for_probe" },
        { status: 404 }
      );
    }
    probeLink = post.mediaUrl;
  } else {
    const account = await prisma.testAccount.findFirst({
      where: {
        status: "available",
        platform: probe.platform,
        accountType: "follower_test",
      },
      orderBy: { firstSeenAt: "asc" },
    });
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "no_pool_entity_for_probe" },
        { status: 404 }
      );
    }
    probeLink =
      probe.platform === "instagram"
        ? `https://www.instagram.com/${account.username}/`
        : `https://www.tiktok.com/@${account.username}`;
  }

  let probeOk = false;
  let probeError = "";
  try {
    const order = await placeOrder({
      service: probe.bulkmedyaId,
      link: probeLink,
      quantity: probeQty,
    });
    if ("error" in order) {
      probeError = String(order.error).slice(0, 300);
    } else {
      probeOk = true;
    }
  } catch (e) {
    probeError = (e as Error).message.slice(0, 300);
  }

  // ── 3. Probe failed with a balance error → still insufficient
  if (!probeOk) {
    if (BALANCE_REGEX.test(probeError)) {
      return NextResponse.json(
        {
          ok: false,
          error: "balance_still_insufficient",
          probeServiceId: probe.id,
          probeError,
        },
        { status: 409 }
      );
    }
    // Other error — surface it but don't queue the retry batch.
    return NextResponse.json(
      {
        ok: false,
        error: "probe_failed_other",
        probeServiceId: probe.id,
        probeError,
      },
      { status: 500 }
    );
  }

  // ── 2. Probe success → queue retry via brute-mode campaign ──
  // Skip the probe service from the queue (it just ran).
  const queueIds = ids.filter((id) => id !== probe.id);

  // Clear the lastPlacementError on the probe service so it
  // doesn't keep showing in the budget card.
  await prisma.service
    .update({
      where: { id: probe.id },
      data: { lastPlacementError: null, lastPlacementErrorAt: null },
    })
    .catch(() => null);

  if (queueIds.length === 0) {
    return NextResponse.json({
      ok: true,
      probeServiceId: probe.id,
      queueSize: 0,
      campaignId: null,
      mode: "probe_only",
    });
  }

  // Compute estimated cost for the queue.
  const queueServices = services.filter((s) => queueIds.includes(s.id));
  const queueCost = queueServices.reduce(
    (acc, s) => acc + (testCostUsd(s) ?? 0),
    0
  );

  // Merge into existing brute campaign or spawn a new one.
  const activeBrute = await prisma.scoringCampaign.findFirst({
    where: { status: "running", stopReason: "brute_mode" },
    orderBy: { id: "desc" },
  });

  let mode: "merged_into_existing" | "new_campaign" = "new_campaign";
  let campaignId: number;
  if (activeBrute) {
    const placed = new Set(activeBrute.placedServiceIds);
    const merged = Array.from(
      new Set([
        ...activeBrute.targetServiceIds,
        ...queueIds.filter((id) => !placed.has(id)),
      ])
    );
    await prisma.scoringCampaign.update({
      where: { id: activeBrute.id },
      data: {
        targetServiceIds: merged,
        estimatedCostUsd:
          (activeBrute.estimatedCostUsd ?? 0) +
          Math.round(queueCost * 100) / 100,
      },
    });
    campaignId = activeBrute.id;
    mode = "merged_into_existing";
  } else {
    const created = await prisma.scoringCampaign.create({
      data: {
        status: "running",
        stopReason: "brute_mode",
        targetServiceIds: queueIds,
        estimatedCostUsd: Math.round(queueCost * 100) / 100,
      },
    });
    campaignId = created.id;
    // Fire-and-forget the first tick so placements start before
    // the next minute-cron firing.
    const origin = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const secret = process.env.CRON_SECRET ?? "";
    void fetch(`${origin}/api/cron/brute-campaign-runner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    }).catch(() => null);
  }

  return NextResponse.json({
    ok: true,
    probeServiceId: probe.id,
    queueSize: queueIds.length,
    campaignId,
    mode,
    estimatedCostUsd: Math.round(queueCost * 100) / 100,
  });
}
