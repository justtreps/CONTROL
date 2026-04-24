// Canonical 8 workflows — the starting kit. Each graph uses the
// full node grammar (FILTER / CONDITION / LOOP / WAIT) so the UI
// editor has a representative example of every branching + timing
// primitive.
//
// Re-running the seed endpoint is idempotent: existing rows get
// their metadata refreshed (displayName / description / cron /
// category / triggerType / eventType) but `nodes` is ONLY overwritten
// when the row was freshly created. Operator edits survive re-seed.

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

export const WORKFLOW_SEEDS: WorkflowSeed[] = [
  // a. Health check — pool abonnés (every 6h)
  {
    slug: "health-check-follower-pool",
    displayName: "Health check — Pool abonnés",
    description:
      "Scanne toutes les 6h le pool follower_test, invalide les comptes morts, notifie si le pool dipse sous le seuil.",
    category: "health",
    triggerType: "cron",
    cronExpression: "0 */6 * * *",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Cron */6h",
        nextNodeId: "fetch",
      },
      {
        id: "fetch",
        type: "FETCH_POOL",
        config: { poolType: "follower" },
        label: "Pool abonnés",
        nextNodeId: "hc",
      },
      {
        id: "hc",
        type: "ACTION_HEALTH_CHECK",
        config: { scope: "follower" },
        label: "Health check",
        nextNodeId: "cond",
      },
      {
        id: "cond",
        type: "CONDITION",
        config: {
          expression: "ctx.poolCount < 500",
          thenNodeId: "notify_low",
          elseNodeId: "notify_ok",
        },
        label: "< 500 comptes ?",
      },
      {
        id: "notify_low",
        type: "NOTIFY",
        config: {
          message:
            "⚠ Pool abonnés sous le seuil : {{ ctx.poolCount }} comptes.",
          severity: "warn",
        },
        label: "Alerte low pool",
      },
      {
        id: "notify_ok",
        type: "NOTIFY",
        config: {
          message:
            "Health check abonnés ok — {{ ctx.poolCount }} comptes.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // b. Health check — pool engagement (every 6h)
  {
    slug: "health-check-engagement-pool",
    displayName: "Health check — Pool engagement",
    description:
      "Scanne toutes les 6h le pool engagement_test + parents, invalide, notifie low pool.",
    category: "health",
    triggerType: "cron",
    cronExpression: "0 */6 * * *",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Cron */6h",
        nextNodeId: "fetch",
      },
      {
        id: "fetch",
        type: "FETCH_POOL",
        config: { poolType: "engagement" },
        label: "Pool engagement",
        nextNodeId: "hc",
      },
      {
        id: "hc",
        type: "ACTION_HEALTH_CHECK",
        config: { scope: "engagement" },
        label: "Health check",
        nextNodeId: "cond",
      },
      {
        id: "cond",
        type: "CONDITION",
        config: {
          expression: "ctx.poolCount < 500",
          thenNodeId: "notify_low",
          elseNodeId: "notify_ok",
        },
        label: "< 500 posts ?",
      },
      {
        id: "notify_low",
        type: "NOTIFY",
        config: {
          message:
            "⚠ Pool engagement sous le seuil : {{ ctx.poolCount }} posts.",
          severity: "warn",
        },
        label: "Alerte low pool",
      },
      {
        id: "notify_ok",
        type: "NOTIFY",
        config: {
          message:
            "Health check engagement ok — {{ ctx.poolCount }} posts.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // c. Auto-refill pool abonnés — event-triggered with IG/TT branch
  {
    slug: "refill-follower-pool",
    displayName: "Auto-refill — Pool abonnés",
    description:
      "Sur event pool.below_threshold.follower, branche selon plateforme et lance un scrape ciblé 500 comptes.",
    category: "pool",
    triggerType: "event",
    eventType: "pool.below_threshold.follower",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Event low_pool",
        nextNodeId: "cond",
      },
      {
        id: "cond",
        type: "CONDITION",
        config: {
          expression: 'ctx.event.payload.platform == "instagram"',
          thenNodeId: "scrape_ig",
          elseNodeId: "scrape_tt",
        },
        label: "Plateforme IG ?",
      },
      {
        id: "scrape_ig",
        type: "ACTION_SCRAPE",
        config: { poolType: "follower", platform: "instagram", count: 500 },
        label: "Scrape IG · 500",
        nextNodeId: "notify",
      },
      {
        id: "scrape_tt",
        type: "ACTION_SCRAPE",
        config: { poolType: "follower", platform: "tiktok", count: 500 },
        label: "Scrape TT · 500",
        nextNodeId: "notify",
      },
      {
        id: "notify",
        type: "NOTIFY",
        config: {
          message:
            "Refill abonnés lancé — job scrape #{{ ctx.scrapeJobId }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // d. Auto-refill engagement — same branching pattern
  {
    slug: "refill-engagement-pool",
    displayName: "Auto-refill — Pool engagement",
    description:
      "Sur event pool.below_threshold.engagement, branche IG/TT, scrape 500 posts.",
    category: "pool",
    triggerType: "event",
    eventType: "pool.below_threshold.engagement",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Event low_pool",
        nextNodeId: "cond",
      },
      {
        id: "cond",
        type: "CONDITION",
        config: {
          expression: 'ctx.event.payload.platform == "instagram"',
          thenNodeId: "scrape_ig",
          elseNodeId: "scrape_tt",
        },
        label: "Plateforme IG ?",
      },
      {
        id: "scrape_ig",
        type: "ACTION_SCRAPE",
        config: { poolType: "engagement", platform: "instagram", count: 500 },
        label: "Scrape IG · 500",
        nextNodeId: "notify",
      },
      {
        id: "scrape_tt",
        type: "ACTION_SCRAPE",
        config: { poolType: "engagement", platform: "tiktok", count: 500 },
        label: "Scrape TT · 500",
        nextNodeId: "notify",
      },
      {
        id: "notify",
        type: "NOTIFY",
        config: {
          message:
            "Refill engagement lancé — job scrape #{{ ctx.scrapeJobId }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // e. Scoring continu — fetch → filter stale → loop over candidates → test → wait 7d → notify
  {
    slug: "scoring-continu",
    displayName: "Scoring continu — Testbot",
    description:
      "Chaque heure : candidats catalogue éligibles + jamais testés, lance testbot en batch, attend 7j pour la mesure finale.",
    category: "scoring",
    triggerType: "cron",
    cronExpression: "0 * * * *",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Cron */1h",
        nextNodeId: "fetch",
      },
      {
        id: "fetch",
        type: "FETCH_SERVICES",
        config: { filters: { isEligible: true, forceExcluded: false } },
        label: "Candidats éligibles",
        nextNodeId: "filter_stale",
      },
      {
        id: "filter_stale",
        type: "FILTER",
        config: { field: "lastTestedAt", operator: "lt", value: null },
        label: "lastTestedAt null",
        nextNodeId: "loop",
      },
      {
        id: "loop",
        type: "LOOP",
        config: {
          iterationKey: "services",
          iterationVar: "candidate",
          bodyNodeId: "body_test",
          afterNodeId: "wait",
        },
        label: "Pour chaque candidat",
      },
      {
        id: "body_test",
        type: "ACTION_TEST",
        config: {},
        label: "Lance test",
      },
      {
        id: "wait",
        type: "WAIT",
        config: { unit: "days", value: 7 },
        label: "Wait T+7d",
        nextNodeId: "notify",
      },
      {
        id: "notify",
        type: "NOTIFY",
        config: {
          message: "Scoring batch terminé — placed={{ ctx.testbot.placed }}.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // f. Sync services — sync → rematch (ACTION_SYNC auto-emits services.synced)
  {
    slug: "sync-services",
    displayName: "Sync services BulkMedya",
    description:
      "Chaque heure : fetch BulkMedya, upsert en DB, ACTION_SYNC émet services.synced qui déclenche le rematch workflow.",
    category: "sync",
    triggerType: "cron",
    cronExpression: "0 * * * *",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Cron */1h",
        nextNodeId: "sync",
      },
      {
        id: "sync",
        type: "ACTION_SYNC",
        config: {},
        label: "Sync BulkMedya",
        nextNodeId: "cond",
      },
      {
        id: "cond",
        type: "CONDITION",
        config: {
          expression: "ctx.sync.created > 0",
          thenNodeId: "notify_new",
          elseNodeId: "notify_nochange",
        },
        label: "Nouveaux services ?",
      },
      {
        id: "notify_new",
        type: "NOTIFY",
        config: {
          message:
            "Sync : {{ ctx.sync.created }} nouveaux services ajoutés, {{ ctx.sync.updated }} mis à jour.",
          severity: "info",
        },
        label: "Nouveaux services",
      },
      {
        id: "notify_nochange",
        type: "NOTIFY",
        config: {
          message: "Sync : aucun nouveau service, {{ ctx.sync.updated }} mis à jour.",
          severity: "info",
        },
        label: "Aucun nouveau",
      },
    ],
  },

  // g. Matching catalogue — on event services.synced
  {
    slug: "catalogue-rematch-on-sync",
    displayName: "Matching catalogue (sur sync)",
    description:
      "Event-triggered sur services.synced. Re-applique le matcher strict sur les 8 produits.",
    category: "catalogue",
    triggerType: "event",
    eventType: "services.synced",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Event services.synced",
        nextNodeId: "rematch",
      },
      {
        id: "rematch",
        type: "ACTION_REMATCH",
        config: {},
        label: "Rematch",
        nextNodeId: "notify",
      },
      {
        id: "notify",
        type: "NOTIFY",
        config: {
          message:
            "Rematch : {{ ctx.rematch.candidatesCreated }} nouveaux candidats, {{ ctx.rematch.candidatesMarkedIneligible }} invalidés.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },

  // h. Cleanup comptes invalides (daily at 04:00 UTC)
  {
    slug: "cleanup-invalid-accounts",
    displayName: "Cleanup — Comptes invalides",
    description:
      "Quotidien 04:00 UTC : fetch les comptes invalides, filtre ceux > 30j, archive.",
    category: "pool",
    triggerType: "cron",
    cronExpression: "0 4 * * *",
    nodes: [
      {
        id: "trigger",
        type: "TRIGGER",
        config: {},
        label: "Cron daily 04:00 UTC",
        nextNodeId: "fetch",
      },
      {
        id: "fetch",
        type: "FETCH_POOL",
        config: {
          poolType: "follower",
          filters: { status: "invalid" },
        },
        label: "Invalides",
        nextNodeId: "del",
      },
      {
        id: "del",
        type: "ACTION_DELETE",
        config: { iterationKey: "pool" },
        label: "Archive",
        nextNodeId: "notify",
      },
      {
        id: "notify",
        type: "NOTIFY",
        config: {
          message: "Cleanup : {{ ctx.poolCount }} comptes archivés.",
          severity: "info",
        },
        label: "Notification",
      },
    ],
  },
];

// Re-seed is idempotent — existing rows keep their nodes JSON so
// operator edits survive a re-run. Brand new rows land with the
// canonical graph above.
export async function seedWorkflows(): Promise<{
  upserted: string[];
  count: number;
  nodesRewrittenFor: string[];
}> {
  const { prisma } = await import("@/lib/prisma");
  const upserted: string[] = [];
  const nodesRewrittenFor: string[] = [];
  for (const w of WORKFLOW_SEEDS) {
    const existing = await prisma.workflow.findUnique({
      where: { slug: w.slug },
      select: { id: true },
    });
    if (!existing) {
      await prisma.workflow.create({
        data: {
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
      });
      nodesRewrittenFor.push(w.slug);
    } else {
      await prisma.workflow.update({
        where: { slug: w.slug },
        data: {
          displayName: w.displayName,
          description: w.description,
          category: w.category,
          triggerType: w.triggerType,
          cronExpression: w.cronExpression ?? null,
          eventType: w.eventType ?? null,
        },
      });
    }
    upserted.push(w.slug);
  }
  return { upserted, count: upserted.length, nodesRewrittenFor };
}
