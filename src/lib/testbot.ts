import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";
import { pickAndAssignAccount, invalidateAccount } from "@/lib/pool/assign";
import { fetchOracleFor } from "@/lib/pool/oracle";
import type { Service, TestAccount } from "@prisma/client";

const ACCOUNT_COOLDOWN_HOURS = 48;
const SERVICE_COOLDOWN_HOURS = 24;

function targetUrlFor(platform: string, username: string): string {
  if (platform === "instagram") return `https://www.instagram.com/${username}/`;
  if (platform === "tiktok") return `https://www.tiktok.com/@${username}`;
  throw new Error(`Unknown platform: ${platform}`);
}

// Legacy fallback: pre-pool manual accounts (scrapeSource IS NULL OR 'manual').
// Used only when the auto pool is empty for the platform.
async function pickLegacyAccountForService(
  service: Service
): Promise<TestAccount | null> {
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
      status: { in: ["available"] },
      OR: [{ scrapeSource: null }, { scrapeSource: "manual" }],
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
    let assignedAccountId: number | null = null;

    try {
      // ─── Resolve account ──────────────────────────────────────────
      // Primary path: pull a virgin account from the pool in an atomic
      // transaction (status flips available→assigned in the same tx).
      // testOrderId is supplied after TestOrder creation — so we first
      // create TestOrder with a temp account reference, then we'd need
      // to swap. Cleaner: create TestOrder AFTER pick, then backfill
      // assignedTestOrderId in a second update.
      let account: TestAccount | null = null;

      // Try the pool first (status='available' only, ordered by firstSeenAt)
      const poolPick = await pickAndAssignAccount({
        platform: service.platform,
        testOrderId: -1, // placeholder; backfilled below after TestOrder exists
      });

      if (poolPick) {
        account = poolPick;
        assignedAccountId = poolPick.id;
      } else {
        // Fallback: manually-seeded accounts (pre-pool era). These keep
        // `scrapeSource IS NULL` or 'manual' and don't get consumed — they
        // can be reused with the cooldown logic below.
        account = await pickLegacyAccountForService(service);
      }

      if (!account) {
        result.skipped++;
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason: "no_available_account",
        });
        continue;
      }

      // ─── Baseline-at-placement ────────────────────────────────────
      // Just before the BulkMedya /add call, re-read the account from
      // the oracle by stable user_id. Gives us:
      //  1. The CURRENT username (in case the account renamed since
      //     scrape — so the BulkMedya link lands on the right profile)
      //  2. A fresh follower_count used as the TestOrder baseline
      //  3. A chance to abort cleanly if the account is now a ghost
      //     or drifted past the invalidate thresholds
      const oracle = await fetchOracleFor(
        service.platform,
        account.userId
      );
      if (!oracle.ok) {
        if (oracle.reason === "ghost" && poolPick) {
          // Account vanished between scrape and now → permanently invalid.
          await invalidateAccount(poolPick.id, "deleted");
          assignedAccountId = null;
        } else if (poolPick) {
          // Transient oracle error — release the account so we can retry later.
          await prisma.testAccount.update({
            where: { id: poolPick.id },
            data: {
              status: "available",
              assignedAt: null,
              assignedTestOrderId: null,
              active: true,
            },
          });
          assignedAccountId = null;
        }
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason:
            oracle.reason === "ghost"
              ? `account_ghost_${account.userId}`
              : `oracle_error: ${oracle.message.slice(0, 80)}`,
        });
        continue;
      }

      // Use the oracle's CURRENT username for the target URL and for
      // realism sampling. Sync the DB row if it drifted.
      const currentUsername = oracle.username || account.username;
      if (currentUsername !== account.username) {
        await prisma.testAccount.update({
          where: { id: account.id },
          data: { username: currentUsername },
        });
        account = { ...account, username: currentUsername };
      }

      // Realism sample still comes from fetchFollowerSnapshot (it does
      // a /followers call and scores the sample). Baseline count comes
      // from the oracle — it's the authoritative number at placement time.
      const sample = await fetchFollowerSnapshot(
        service.platform as Platform,
        currentUsername,
        oracle.userId
      );
      const baseline = {
        count: oracle.followerCount,
        realismScore: sample.realismScore,
        realismData: sample.realismData,
      };

      const order = await placeOrder({
        service: service.bulkmedyaId,
        link: targetUrlFor(service.platform, currentUsername),
        quantity: service.minQuantity,
      });

      if ("error" in order) {
        // Pool-assigned accounts that failed to order → rollback to available
        // so we don't burn a virgin account on a BulkMedya error.
        if (poolPick) {
          await prisma.testAccount.update({
            where: { id: poolPick.id },
            data: {
              status: "available",
              assignedAt: null,
              assignedTestOrderId: null,
              active: true,
            },
          });
          assignedAccountId = null;
        }
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

      // Pool-assigned: backfill the real TestOrder id on the account.
      if (poolPick) {
        await prisma.testAccount.update({
          where: { id: poolPick.id },
          data: { assignedTestOrderId: testOrder.id },
        });
      }

      await prisma.measurement.create({
        data: {
          testOrderId: testOrder.id,
          checkpoint: "T+0",
          actualCount: baseline.count,
          realismData: baseline.realismData,
          realismScore: baseline.realismScore,
        },
      });

      // Legacy accounts: keep the cooldown mechanism.
      if (!poolPick) {
        await prisma.testAccount.update({
          where: { id: account.id },
          data: { lastTestedAt: new Date() },
        });
      }

      result.placed++;
    } catch (e) {
      // Rollback pool assignment on any unexpected error so the virgin
      // account returns to the pool.
      if (assignedAccountId) {
        await prisma.testAccount
          .update({
            where: { id: assignedAccountId },
            data: {
              status: "available",
              assignedAt: null,
              assignedTestOrderId: null,
              active: true,
            },
          })
          .catch(() => null);
      }
      result.errors.push({
        serviceId: service.id,
        serviceName: service.name,
        reason: (e as Error).message,
      });
    }
  }

  return result;
}
