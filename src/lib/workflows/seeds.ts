// Canonical 8 workflows — the starting kit. Every flow wires
// existing behaviour through the new executor so the operator sees
// the same cron work surfaced under /workflows. No migration or
// kill-switch flip happens yet — the legacy crons keep running in
// parallel until a follow-up commit disables them.

import type { NodesArray } from "./nodes";

type WorkflowSeed = {
  slug: string;
  displayName: string;
  description: string;
  category: "health" | "pool" | "scoring" | "sync" | "catalogue";
  triggerType: "cron" | "event" | "manual";
  cronExpression?: string;
  eventType?: string;
  nodes: NodesArray;
};

// Helper — linear chain of nodes with deterministic ids (n1, n2, …).
function chain(
  steps: Array<Omit<NodesArray[number], "id" | "nextNodeId">>
): NodesArray {
  return steps.map((s, i) => ({
    ...s,
    id: `n${i + 1}`,
    nextNodeId: i < steps.length - 1 ? `n${i + 2}` : undefined,
  }));
}

export const WORKFLOW_SEEDS: WorkflowSeed[] = [
  // a. Health check — pool abonnés (every 6h)
  {
    slug: "health-check-follower-pool",
    displayName: "Health check — Pool abonnés",
    description:
      "Scanne toutes les 6h le pool de comptes follower_test, invalide ceux qui sont devenus privés / supprimés / bannis.",
    category: "health",
    triggerType: "cron",
    cronExpression: "0 */6 * * *",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Cron */6h" },
      {
        type: "FETCH_POOL",
        config: { poolType: "follower" },
        label: "Pool abonnés",
      },
      {
        type: "ACTION_HEALTH_CHECK",
        config: { scope: "follower" },
        label: "Health check",
      },
      {
        type: "NOTIFY",
        config: {
          message:
            "Health check abonnés terminé — pool: {{ ctx.poolCount }} comptes.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // b. Health check — pool engagement (every 6h)
  {
    slug: "health-check-engagement-pool",
    displayName: "Health check — Pool engagement",
    description:
      "Scanne toutes les 6h le pool de posts engagement_test + leurs parents, invalide les comptes morts.",
    category: "health",
    triggerType: "cron",
    cronExpression: "0 */6 * * *",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Cron */6h" },
      {
        type: "FETCH_POOL",
        config: { poolType: "engagement" },
        label: "Pool engagement",
      },
      {
        type: "ACTION_HEALTH_CHECK",
        config: { scope: "engagement" },
        label: "Health check",
      },
      {
        type: "NOTIFY",
        config: {
          message:
            "Health check engagement terminé — pool: {{ ctx.poolCount }} comptes.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // c. Auto-refill pool abonnés (event)
  {
    slug: "refill-follower-pool",
    displayName: "Auto-refill — Pool abonnés",
    description:
      "Déclenché quand le pool abonnés passe sous le seuil min. Lance un scrape pour rafraîchir.",
    category: "pool",
    triggerType: "event",
    eventType: "pool.below_threshold.follower",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Event low_pool" },
      {
        type: "FETCH_POOL",
        config: { poolType: "follower" },
        label: "Pool abonnés",
      },
      {
        type: "FILTER",
        config: { field: "poolCount", operator: "lt", value: 500 },
        label: "< 500 comptes",
      },
      {
        type: "ACTION_SCRAPE",
        config: { poolType: "follower", count: 500 },
        label: "Scrape 500",
      },
      {
        type: "NOTIFY",
        config: {
          message:
            "Refill abonnés lancé — job scrape #{{ ctx.scrapeJobId }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // d. Auto-refill pool engagement (event)
  {
    slug: "refill-engagement-pool",
    displayName: "Auto-refill — Pool engagement",
    description:
      "Déclenché quand le pool engagement passe sous le seuil min. Lance un scrape pour rafraîchir.",
    category: "pool",
    triggerType: "event",
    eventType: "pool.below_threshold.engagement",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Event low_pool" },
      {
        type: "FETCH_POOL",
        config: { poolType: "engagement" },
        label: "Pool engagement",
      },
      {
        type: "FILTER",
        config: { field: "poolCount", operator: "lt", value: 500 },
        label: "< 500 posts",
      },
      {
        type: "ACTION_SCRAPE",
        config: { poolType: "engagement", count: 500 },
        label: "Scrape 500",
      },
      {
        type: "NOTIFY",
        config: {
          message:
            "Refill engagement lancé — job scrape #{{ ctx.scrapeJobId }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // e. Scoring continu testbot (every 1h)
  {
    slug: "scoring-continu",
    displayName: "Scoring continu — Testbot",
    description:
      "Chaque heure : pick les candidats catalogue éligibles, lance le testbot, scoring automatique après T+7d.",
    category: "scoring",
    triggerType: "cron",
    cronExpression: "0 * * * *",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Cron */1h" },
      {
        type: "FETCH_SERVICES",
        config: { filters: { isEligible: true, forceExcluded: false } },
        label: "Services éligibles",
      },
      {
        type: "FILTER",
        config: { field: "lastTestedAt", operator: "lt", value: null },
        label: "Jamais testé / stale",
      },
      {
        type: "ACTION_TEST",
        config: {},
        label: "Lance tests",
      },
      {
        type: "WAIT",
        config: { unit: "days", value: 7 },
        label: "Wait T+7d",
      },
      {
        type: "NOTIFY",
        config: {
          message: "Scoring terminé — placed={{ ctx.testbot.placed }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // f. Sync services BulkMedya (every 1h)
  {
    slug: "sync-services",
    displayName: "Sync services BulkMedya",
    description:
      "Chaque heure : fetch la liste BulkMedya, upsert en DB, re-match le catalogue automatiquement.",
    category: "sync",
    triggerType: "cron",
    cronExpression: "0 * * * *",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Cron */1h" },
      { type: "ACTION_SYNC", config: {}, label: "Sync BulkMedya" },
      { type: "ACTION_REMATCH", config: {}, label: "Rematch catalogue" },
      {
        type: "NOTIFY",
        config: {
          message:
            "Sync terminé — créés={{ ctx.sync.created }} mis à jour={{ ctx.sync.updated }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // g. Matching catalogue (event)
  {
    slug: "catalogue-rematch-on-sync",
    displayName: "Matching catalogue (sur sync)",
    description:
      "Déclenché après un sync services réussi. Re-applique le matcher strict sur les 8 produits MyBoost.",
    category: "catalogue",
    triggerType: "event",
    eventType: "services.synced",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Event services.synced" },
      { type: "ACTION_REMATCH", config: {}, label: "Rematch" },
      {
        type: "NOTIFY",
        config: {
          message:
            "Rematch : {{ ctx.rematch.candidatesCreated }} nouveaux candidats.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },

  // h. Cleanup comptes invalides (daily at 04:00 UTC)
  {
    slug: "cleanup-invalid-accounts",
    displayName: "Cleanup — Comptes invalides",
    description:
      "Chaque jour : archive les comptes status='invalid' depuis plus de 30 jours.",
    category: "pool",
    triggerType: "cron",
    cronExpression: "0 4 * * *",
    nodes: chain([
      { type: "TRIGGER", config: {}, label: "Cron daily 04:00 UTC" },
      {
        type: "FETCH_POOL",
        config: {
          poolType: "follower",
          filters: { status: "invalid" },
        },
        label: "Pool invalides",
      },
      {
        type: "FILTER",
        config: { field: "invalidatedAt", operator: "lt", value: 30 },
        label: "> 30 jours",
      },
      {
        type: "ACTION_DELETE",
        config: { iterationKey: "pool" },
        label: "Archiver",
      },
      {
        type: "NOTIFY",
        config: {
          message: "Cleanup : {{ ctx.poolCount }} comptes archivés.",
          severity: "info",
        },
        label: "Notification",
      },
    ]),
  },
];

export async function seedWorkflows(): Promise<{
  upserted: string[];
  count: number;
}> {
  const { prisma } = await import("@/lib/prisma");
  const upserted: string[] = [];
  for (const w of WORKFLOW_SEEDS) {
    await prisma.workflow.upsert({
      where: { slug: w.slug },
      create: {
        slug: w.slug,
        displayName: w.displayName,
        description: w.description,
        category: w.category,
        triggerType: w.triggerType,
        cronExpression: w.cronExpression ?? null,
        eventType: w.eventType ?? null,
        nodes:
          w.nodes as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
      update: {
        // Preserve isActive + nodes customisations made through the UI.
        displayName: w.displayName,
        description: w.description,
        category: w.category,
        triggerType: w.triggerType,
        cronExpression: w.cronExpression ?? null,
        eventType: w.eventType ?? null,
        // Only overwrite nodes on the VERY first seed (when the row
        // was just created above); skip on updates so operator edits
        // survive re-seeds. Detect first-create via a fresh count.
        // Simplest: skip nodes on update; fresh seed already landed
        // them via create().
      },
    });
    upserted.push(w.slug);
  }
  return { upserted, count: upserted.length };
}
