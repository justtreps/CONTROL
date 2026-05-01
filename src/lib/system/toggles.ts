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

// Standard "enabled" toggles — stopAll flips all to false,
// restartAll to true. Every one of these is "true means the
// subsystem runs normally". Typed as a tuple of boolean keys so
// the patch assignments below stay strictly typed despite
// SystemToggle now containing non-boolean fields too
// (pollIntervalMinutes etc.).
type BooleanToggleKey =
  | "poolScrapeEnabled"
  | "poolHealthcheckEnabled"
  | "routingApiEnabled"
  | "testBotEnabled"
  | "scoringEngineEnabled"
  | "workflowExecutorEnabled"
  | "dailyRetestEnabled"
  | "autoKillDeadServicesEnabled"
  | "dailySyncEnabled";
const ENABLED_KEYS: BooleanToggleKey[] = [
  "poolScrapeEnabled",
  "poolHealthcheckEnabled",
  "routingApiEnabled",
  "testBotEnabled",
  "scoringEngineEnabled",
  "workflowExecutorEnabled",
  "dailyRetestEnabled",
  "autoKillDeadServicesEnabled",
  "dailySyncEnabled",
];

// dryRunMode is inverted (true means simulation / safe). Handled
// separately so an emergency stopAll pushes us to the safest
// possible state (everything off + dry run on), and restartAll
// leaves the mode untouched so the operator opts into production
// explicitly via the dedicated toggle.
const ALL_KEYS: Array<keyof TogglePatch> = [
  ...ENABLED_KEYS,
  "dryRunMode",
];

export async function stopAll(): Promise<SystemToggle> {
  const patch: TogglePatch = {};
  for (const k of ENABLED_KEYS) patch[k] = false;
  patch.dryRunMode = true; // safe state
  return updateSystemToggles(patch);
}

export async function restartAll(): Promise<SystemToggle> {
  const patch: TogglePatch = {};
  for (const k of ENABLED_KEYS) patch[k] = true;
  // Intentionally NOT touching dryRunMode here — production mode
  // should be an explicit operator choice, not a side-effect of
  // clicking RESTART ALL.
  return updateSystemToggles(patch);
}

// Count of DISABLED subsystems — powers the banner. dryRunMode
// isn't a "disabled subsystem" in this sense so we skip it.
export function countDisabled(t: SystemToggle): number {
  return ENABLED_KEYS.filter((k) => t[k] === false).length;
}

// Polling cadence helpers — kept here so consumers don't reach
// directly into prisma.systemToggle for a single field.
export const DEFAULT_POLL_INTERVAL_MIN = 10;
export const MIN_POLL_INTERVAL_MIN = 5;
export const MAX_POLL_INTERVAL_MIN = 720; // 12 h ceiling

export async function getPollIntervalMin(): Promise<number> {
  const t = await getSystemToggles();
  const raw = (t as { pollIntervalMinutes?: number }).pollIntervalMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_POLL_INTERVAL_MIN;
  }
  return Math.min(MAX_POLL_INTERVAL_MIN, Math.max(MIN_POLL_INTERVAL_MIN, raw));
}

export const SYSTEM_TOGGLE_KEYS = ALL_KEYS;
