// System-wide kill switch.
//
// Every gated entry-point (pool scrape endpoint + orchestrator tick,
// health-check endpoint + daily cron, /api/order, test-bot, scoring
// cron) asks `getSystemToggles()` once and early-exits with 503 or a
// skip when the matching flag is false. Lazy-creates the id=1 row on
// first read so a clean install is never broken by a missing toggle.

import { prisma } from "@/lib/prisma";
import type { SystemToggle } from "@prisma/client";

export async function getSystemToggles(): Promise<SystemToggle> {
  const row = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  if (row) return row;
  return prisma.systemToggle.create({ data: { id: 1 } });
}

export type TogglePatch = Partial<
  Omit<SystemToggle, "id" | "updatedAt">
>;

export async function updateSystemToggles(
  patch: TogglePatch
): Promise<SystemToggle> {
  await getSystemToggles();
  return prisma.systemToggle.update({ where: { id: 1 }, data: patch });
}

const ALL_KEYS: Array<keyof TogglePatch> = [
  "poolScrapeEnabled",
  "poolHealthcheckEnabled",
  "routingApiEnabled",
  "testBotEnabled",
  "scoringEngineEnabled",
];

export async function stopAll(): Promise<SystemToggle> {
  const patch: TogglePatch = {};
  for (const k of ALL_KEYS) patch[k] = false;
  return updateSystemToggles(patch);
}

export async function restartAll(): Promise<SystemToggle> {
  const patch: TogglePatch = {};
  for (const k of ALL_KEYS) patch[k] = true;
  return updateSystemToggles(patch);
}

// Count of DISABLED toggles — used by the global warning bar.
export function countDisabled(t: SystemToggle): number {
  return ALL_KEYS.filter((k) => t[k] === false).length;
}

export const SYSTEM_TOGGLE_KEYS = ALL_KEYS;
