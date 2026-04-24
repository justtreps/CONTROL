// MyBoost → CONTROL order routing.
//
// Two entry shapes supported:
//   1. Preferred: { product: "ig-followers", quantity, targetUrl }
//      → look up MyBoostProduct by slug, pick the best-ranked Product
//        ServiceCandidate with isEligible + !forceExcluded, fall back
//        through ranks on error.
//   2. Legacy:   { platform: "instagram", serviceType: "followers", ... }
//      → mapped to the canonical slug `${platformPrefix}-${type}`
//        before the same candidate-based routing runs. Keeps
//        MyBoost's existing caller shape working until migration.
//
// The old ServiceScore.currentScore path is retained as a tiebreaker
// when a candidate has no ProductServiceCandidate.currentScore yet
// (freshly seeded catalog, scoring hasn't run over it).

import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { getSystemToggles } from "@/lib/system/toggles";

export type RouteOrderInput = {
  platform?: string;
  serviceType?: string;
  product?: string;
  quantity: number;
  targetUrl: string;
};

export type ChosenService = {
  id: number;
  bulkmedyaId: number;
  name: string;
  ratePerK: number;
};

export type RouteOrderSuccess = {
  success: true;
  dryRun: boolean;
  bulkmedyaOrderId: string;
  chosenService: ChosenService;
  score: number | null;
  attempts: number;
  productSlug: string | null;
};

export type RouteOrderFailure = {
  success: false;
  dryRun: boolean;
  error: string;
  attempts: number;
  productSlug: string | null;
};

export type RouteOrderResult = RouteOrderSuccess | RouteOrderFailure;

const MAX_ATTEMPTS = 5;

// DB-backed dry-run check with a small in-memory cache. Reads
// SystemToggle.dryRunMode and caches the value for 30 s so hot paths
// (routeOrder per /api/order call, testbot placement loops) don't
// hit the DB every single time. Default-true semantics preserved —
// if the table is empty, getSystemToggles() lazy-creates a row with
// dryRunMode=true.
let _dryRunCache: { value: boolean; cachedAt: number } | null = null;
const DRY_RUN_TTL_MS = 30_000;

export async function isDryRun(): Promise<boolean> {
  if (
    _dryRunCache &&
    Date.now() - _dryRunCache.cachedAt < DRY_RUN_TTL_MS
  ) {
    return _dryRunCache.value;
  }
  const t = await getSystemToggles();
  _dryRunCache = { value: t.dryRunMode, cachedAt: Date.now() };
  return t.dryRunMode;
}

/**
 * Invalidate the in-memory dry-run cache. Called by the toggle
 * PATCH endpoint so a flip propagates to callers within one read
 * instead of up to 30 s later.
 */
export function invalidateDryRunCache(): void {
  _dryRunCache = null;
}

// Maps legacy (platform, serviceType) into the canonical product slug.
function legacySlugFor(
  platform: string | undefined,
  serviceType: string | undefined
): string | null {
  if (!platform || !serviceType) return null;
  const p = platform.toLowerCase();
  const t = serviceType.toLowerCase();
  const prefix = p === "instagram" ? "ig" : p === "tiktok" ? "tt" : null;
  if (!prefix) return null;
  const canonicalType = [
    "followers",
    "likes",
    "views",
    "shares",
    "saves",
  ].includes(t)
    ? t
    : null;
  if (!canonicalType) return null;
  return `${prefix}-${canonicalType}`;
}

export async function routeOrder(
  input: RouteOrderInput
): Promise<RouteOrderResult> {
  const { quantity, targetUrl } = input;
  const dryRun = await isDryRun();

  // Resolve product slug — prefer the explicit one.
  const slug =
    input.product ?? legacySlugFor(input.platform, input.serviceType);

  if (!slug) {
    await prisma.routingDecision.create({
      data: {
        platform: input.platform ?? "",
        serviceType: input.serviceType ?? "",
        quantity,
        targetUrl,
        attempts: 0,
        success: false,
        dryRun,
        errorMessage: "invalid_product_or_legacy_mapping",
      },
    });
    return {
      success: false,
      dryRun,
      error: "invalid_product_or_legacy_mapping",
      attempts: 0,
      productSlug: null,
    };
  }

  const product = await prisma.myBoostProduct.findUnique({
    where: { slug },
    select: { id: true, slug: true, platform: true, productType: true },
  });
  if (!product || !product) {
    await prisma.routingDecision.create({
      data: {
        platform: input.platform ?? "",
        serviceType: input.serviceType ?? "",
        quantity,
        targetUrl,
        attempts: 0,
        success: false,
        dryRun,
        errorMessage: `unknown_product:${slug}`,
      },
    });
    return {
      success: false,
      dryRun,
      error: "unknown_product",
      attempts: 0,
      productSlug: slug,
    };
  }

  // Eligible candidates for this product + this quantity window.
  // rank ASC (null last) is the source of truth for routing order —
  // the scoring engine maintains it.
  const candidates = await prisma.productServiceCandidate.findMany({
    where: {
      productId: product.id,
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        minQuantity: { lte: quantity },
        maxQuantity: { gte: quantity },
      },
    },
    orderBy: [
      { rank: { sort: "asc", nulls: "last" } },
      { currentScore: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    include: {
      service: {
        select: {
          id: true,
          bulkmedyaId: true,
          name: true,
          ratePerK: true,
        },
      },
    },
    take: MAX_ATTEMPTS,
  });

  if (candidates.length === 0) {
    await prisma.routingDecision.create({
      data: {
        platform: product.platform,
        serviceType: product.productType,
        quantity,
        targetUrl,
        attempts: 0,
        success: false,
        dryRun,
        errorMessage: "no_eligible_service",
      },
    });
    return {
      success: false,
      dryRun,
      error: "no_eligible_service",
      attempts: 0,
      productSlug: slug,
    };
  }

  let lastError = "no_attempts";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const attempts = i + 1;

    try {
      let bulkmedyaOrderId: string;
      if (dryRun) {
        bulkmedyaOrderId = `DRYRUN-${c.service.bulkmedyaId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
      } else {
        const order = await placeOrder({
          service: c.service.bulkmedyaId,
          link: targetUrl,
          quantity,
        });
        if ("error" in order) {
          lastError = `bulkmedya: ${order.error}`;
          continue;
        }
        bulkmedyaOrderId = String(order.order);
      }

      await prisma.routingDecision.create({
        data: {
          platform: product.platform,
          serviceType: product.productType,
          quantity,
          targetUrl,
          chosenServiceId: c.service.id,
          chosenServiceScore: c.currentScore ?? null,
          bulkmedyaOrderId,
          attempts,
          success: true,
          dryRun,
        },
      });

      return {
        success: true,
        dryRun,
        bulkmedyaOrderId,
        chosenService: {
          id: c.service.id,
          bulkmedyaId: c.service.bulkmedyaId,
          name: c.service.name,
          ratePerK: c.service.ratePerK,
        },
        score: c.currentScore ?? null,
        attempts,
        productSlug: slug,
      };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  const topCandidate = candidates[0];
  await prisma.routingDecision.create({
    data: {
      platform: product.platform,
      serviceType: product.productType,
      quantity,
      targetUrl,
      chosenServiceId: topCandidate.service.id,
      chosenServiceScore: topCandidate.currentScore ?? null,
      attempts: candidates.length,
      success: false,
      dryRun,
      errorMessage: lastError,
    },
  });

  return {
    success: false,
    dryRun,
    error: lastError,
    attempts: candidates.length,
    productSlug: slug,
  };
}
