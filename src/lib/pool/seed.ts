// Idempotent seeder for the pool system's reference data:
//   - PoolConfig row id=1 with default thresholds / quotas
//   - Default PoolSeedAccount list (Instagram + TikTok)
//   - Default PoolUsernamePrefix list
//
// Safe to run multiple times — every insert is an upsert by its
// natural key. Called on app boot via ensurePoolDefaults() (see
// lib/pool/config.ts) and on demand via POST /api/pool/seed-defaults.

import { prisma } from "@/lib/prisma";

const DEFAULT_INSTAGRAM_SEEDS = [
  "cristiano",
  "leomessi",
  "kyliejenner",
  "therock",
  "arianagrande",
  "beyonce",
  "taylorswift",
  "kimkardashian",
  "nike",
  "instagram",
];

const DEFAULT_TIKTOK_SEEDS = [
  "khaby.lame",
  "charlidamelio",
  "bellapoarch",
  "mrbeast",
  "zachking",
  "addisonre",
];

const DEFAULT_PREFIXES = [
  "user",
  "insta",
  "mike",
  "sarah",
  "alex",
  "max",
  "leo",
  "emma",
  "lucas",
  "nina",
  "tom",
  "anna",
  "paul",
  "lisa",
  "kevin",
  "chloe",
  "julia",
  "simon",
];

export type SeedResult = {
  configCreated: boolean;
  seedsAdded: number;
  seedsTotal: number;
  prefixesAdded: number;
  prefixesTotal: number;
};

export async function seedPoolDefaults(): Promise<SeedResult> {
  // 1. Ensure the PoolConfig row exists (id=1). If it already exists,
  //    leave the user's edited values alone.
  const existingConfig = await prisma.poolConfig.findUnique({
    where: { id: 1 },
  });
  if (!existingConfig) {
    await prisma.poolConfig.create({ data: { id: 1 } });
  }

  // 2. Upsert seed accounts (unique on [platform, username]).
  let seedsAdded = 0;
  for (const username of DEFAULT_INSTAGRAM_SEEDS) {
    const res = await prisma.poolSeedAccount.upsert({
      where: { platform_username: { platform: "instagram", username } },
      update: {},
      create: { platform: "instagram", username, priority: 0 },
    });
    if (res.addedAt.getTime() > Date.now() - 2000) seedsAdded++;
  }
  for (const username of DEFAULT_TIKTOK_SEEDS) {
    const res = await prisma.poolSeedAccount.upsert({
      where: { platform_username: { platform: "tiktok", username } },
      update: {},
      create: { platform: "tiktok", username, priority: 0 },
    });
    if (res.addedAt.getTime() > Date.now() - 2000) seedsAdded++;
  }

  // 3. Upsert prefixes (unique on prefix).
  let prefixesAdded = 0;
  for (const prefix of DEFAULT_PREFIXES) {
    const before = await prisma.poolUsernamePrefix.findUnique({
      where: { prefix },
    });
    await prisma.poolUsernamePrefix.upsert({
      where: { prefix },
      update: {},
      create: { prefix },
    });
    if (!before) prefixesAdded++;
  }

  const [seedsTotal, prefixesTotal] = await Promise.all([
    prisma.poolSeedAccount.count(),
    prisma.poolUsernamePrefix.count(),
  ]);

  return {
    configCreated: !existingConfig,
    seedsAdded,
    seedsTotal,
    prefixesAdded,
    prefixesTotal,
  };
}
