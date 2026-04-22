// Typed accessor for the PoolConfig singleton (id=1). Lazy-creates the
// row on first call so ensurePoolDefaults() doesn't strictly need to
// run before the rest of the pool system.

import { prisma } from "@/lib/prisma";
import type { PoolConfig } from "@prisma/client";

export async function getPoolConfig(): Promise<PoolConfig> {
  const cfg = await prisma.poolConfig.findUnique({ where: { id: 1 } });
  if (cfg) return cfg;
  return prisma.poolConfig.create({ data: { id: 1 } });
}

export async function updatePoolConfig(
  patch: Partial<Omit<PoolConfig, "id" | "updatedAt">>
): Promise<PoolConfig> {
  await getPoolConfig(); // ensure row exists
  return prisma.poolConfig.update({
    where: { id: 1 },
    data: patch,
  });
}

// Platform-aware follower cap. IG is strict (5), TT is tolerant (30)
// because TT's viral exposure randomly pushes dormant accounts to
// 5-30 followers. Callers that already branched on platform should
// use this helper instead of picking the field themselves so the
// rule stays consistent across scraper / health-check / sweep /
// recheck.
export function followerCapFor(
  platform: string,
  cfg: Pick<PoolConfig, "maxFollowerCount" | "maxFollowerCountTiktok">
): number {
  return platform === "tiktok"
    ? cfg.maxFollowerCountTiktok
    : cfg.maxFollowerCount;
}
