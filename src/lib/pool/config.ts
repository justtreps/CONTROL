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
