import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";
import type { Service, TestAccount } from "@prisma/client";

const ACCOUNT_COOLDOWN_HOURS = 48;
const SERVICE_COOLDOWN_HOURS = 24;

function targetUrlFor(platform: string, username: string): string {
  if (platform === "instagram") return `https://www.instagram.com/${username}/`;
  if (platform === "tiktok") return `https://www.tiktok.com/@${username}`;
  throw new Error(`Unknown platform: ${platform}`);
}

async function pickAccountForService(service: Service): Promise<TestAccount | null> {
  const cutoff = new Date(Date.now() - ACCOUNT_COOLDOWN_HOURS * 3600 * 1000);

  const recent = await prisma.testOrder.findMany({
    where: { serviceId: service.id, placedAt: { gte: cutoff } },
    select: { testAccountId: true },
  });
  const excludeIds = recent.map((r) => r.testAccountId);

  return prisma.testAccount.findFirst({
    where: {
      platform: service.platform,
      active: true,
      ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
    },
    orderBy: [{ lastTestedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
}

export type TestBotResult = {
  attempted: number;
  placed: number;
  skipped: number;
  errors: Array<{ serviceId: number; serviceName: string; reason: string }>;
};

export async function runTestBot(
  opts: { maxOrders?: number } = {}
): Promise<TestBotResult> {
  const maxOrders = opts.maxOrders ?? 10;
  const result: TestBotResult = { attempted: 0, placed: 0, skipped: 0, errors: [] };

  const cutoff = new Date(Date.now() - SERVICE_COOLDOWN_HOURS * 3600 * 1000);

  const services = await prisma.service.findMany({
    where: {
      active: true,
      platform: { in: ["instagram", "tiktok"] },
    },
    include: {
      testOrders: { orderBy: { placedAt: "desc" }, take: 1 },
    },
  });

  const due = services
    .filter((s) => {
      const last = s.testOrders[0];
      return !last || last.placedAt < cutoff;
    })
    .sort((a, b) => {
      const la = a.testOrders[0]?.placedAt?.getTime() ?? 0;
      const lb = b.testOrders[0]?.placedAt?.getTime() ?? 0;
      return la - lb;
    })
    .slice(0, maxOrders);

  for (const service of due) {
    result.attempted++;
    try {
      const account = await pickAccountForService(service);
      if (!account) {
        result.skipped++;
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason: "no_available_account",
        });
        continue;
      }

      const baseline = await fetchFollowerSnapshot(
        service.platform as Platform,
        account.username,
        account.userId
      );

      const order = await placeOrder({
        service: service.bulkmedyaId,
        link: targetUrlFor(service.platform, account.username),
        quantity: service.minQuantity,
      });

      if ("error" in order) {
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason: `bulkmedya: ${order.error}`,
        });
        continue;
      }

      const testOrder = await prisma.testOrder.create({
        data: {
          serviceId: service.id,
          testAccountId: account.id,
          bulkmedyaOrderId: String(order.order),
          targetQuantity: service.minQuantity,
          baselineCount: baseline.count,
        },
      });

      await prisma.measurement.create({
        data: {
          testOrderId: testOrder.id,
          checkpoint: "T+0",
          actualCount: baseline.count,
          realismData: baseline.realismData,
          realismScore: baseline.realismScore,
        },
      });

      await prisma.testAccount.update({
        where: { id: account.id },
        data: { lastTestedAt: new Date() },
      });

      result.placed++;
    } catch (e) {
      result.errors.push({
        serviceId: service.id,
        serviceName: service.name,
        reason: (e as Error).message,
      });
    }
  }

  return result;
}
