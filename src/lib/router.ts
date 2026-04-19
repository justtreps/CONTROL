import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";

export type RouteOrderInput = {
  platform: string;
  serviceType: string;
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
};

export type RouteOrderFailure = {
  success: false;
  dryRun: boolean;
  error: string;
  attempts: number;
};

export type RouteOrderResult = RouteOrderSuccess | RouteOrderFailure;

const MAX_ATTEMPTS = 3;

export function isDryRun(): boolean {
  const v = (process.env.DRY_RUN ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "";
}

export async function routeOrder(input: RouteOrderInput): Promise<RouteOrderResult> {
  const platform = input.platform.toLowerCase();
  const serviceType = input.serviceType.toLowerCase();
  const { quantity, targetUrl } = input;
  const dryRun = isDryRun();

  const eligible = await prisma.service.findMany({
    where: {
      active: true,
      platform,
      serviceType,
      minQuantity: { lte: quantity },
      maxQuantity: { gte: quantity },
    },
    include: { scores: { orderBy: { computedAt: "desc" }, take: 1 } },
  });

  if (eligible.length === 0) {
    await prisma.routingDecision.create({
      data: {
        platform,
        serviceType,
        quantity,
        targetUrl,
        attempts: 0,
        success: false,
        dryRun,
        errorMessage: "no_eligible_service",
      },
    });
    return { success: false, dryRun, error: "no_eligible_service", attempts: 0 };
  }

  const ranked = [...eligible].sort((a, b) => {
    const sa = a.scores[0]?.currentScore;
    const sb = b.scores[0]?.currentScore;
    if (sa != null && sb != null && sa !== sb) return sb - sa;
    if (sa != null && sb == null) return -1;
    if (sa == null && sb != null) return 1;
    return a.ratePerK - b.ratePerK;
  });

  const candidates = ranked.slice(0, MAX_ATTEMPTS);
  let lastError = "no_attempts";

  for (let i = 0; i < candidates.length; i++) {
    const service = candidates[i];
    const score = service.scores[0]?.currentScore ?? null;
    const attempts = i + 1;

    try {
      let bulkmedyaOrderId: string;

      if (dryRun) {
        bulkmedyaOrderId = `DRYRUN-${service.bulkmedyaId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
      } else {
        const order = await placeOrder({
          service: service.bulkmedyaId,
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
          platform,
          serviceType,
          quantity,
          targetUrl,
          chosenServiceId: service.id,
          chosenServiceScore: score,
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
          id: service.id,
          bulkmedyaId: service.bulkmedyaId,
          name: service.name,
          ratePerK: service.ratePerK,
        },
        score,
        attempts,
      };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  const topService = candidates[0];
  await prisma.routingDecision.create({
    data: {
      platform,
      serviceType,
      quantity,
      targetUrl,
      chosenServiceId: topService.id,
      chosenServiceScore: topService.scores[0]?.currentScore ?? null,
      attempts: candidates.length,
      success: false,
      dryRun,
      errorMessage: lastError,
    },
  });

  return { success: false, dryRun, error: lastError, attempts: candidates.length };
}
