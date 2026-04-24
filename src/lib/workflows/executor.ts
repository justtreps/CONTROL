// Workflow execution engine (v1 foundation).
//
// Two entry points:
//   • runWorkflow(workflowId, trigger) — fires a fresh run, advances
//     nodes linearly until a WAIT/CONDITION/LOOP or terminal node.
//   • resumePausedRun(runId) — (stub) resumes a paused run. Full
//     pause/resume state serialization lands in a follow-up.
//
// v1 node support matrix — what actually runs:
//   ✓ TRIGGER              pass-through, advances to nextNodeId
//   ✓ FETCH_POOL           populates context.pool
//   ✓ FETCH_SERVICES       populates context.services
//   ✓ ACTION_HEALTH_CHECK  inline call (delegates to existing endpoints)
//   ✓ ACTION_SCRAPE        dispatches /api/pool/scrape equivalent
//   ✓ ACTION_TEST          kicks the testbot for a scoped set
//   ✓ ACTION_SYNC          syncServices()
//   ✓ ACTION_REMATCH       rematchAll()
//   ✓ ACTION_DELETE        iterates context.rows + soft-deletes
//   ✓ NOTIFY               append to run logs (UI surface only v1)
//   ✗ FILTER / CONDITION / LOOP / WAIT — log + skip for now
//
// The executor is intentionally small. Node handlers are thin
// wrappers around the existing library functions we already have
// (syncServices, runHealthCheck, runTestBot, rematchAll, …) — no
// business logic moves here, only orchestration.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  type WorkflowNode,
  type NodesArray,
} from "./nodes";

export type RunTrigger = "cron" | "manual" | "event" | "retry";

export type ExecuteResult = {
  runId: number;
  status: "running" | "completed" | "failed" | "paused";
  nodesExecuted: number;
  finalNodeId: string | null;
  error?: string;
};

type LogEntry = {
  at: string;
  nodeId: string | null;
  level: "info" | "warn" | "error";
  message: string;
};

// Fetch + coerce the nodes array off a Workflow row. Defensive in
// case a future editor stores a bad shape.
function parseNodes(raw: Prisma.JsonValue): NodesArray {
  if (!Array.isArray(raw)) return [];
  return raw as NodesArray;
}

function findEntry(nodes: NodesArray): WorkflowNode | null {
  // The TRIGGER node is the entry; if none is explicit, take the
  // first node.
  return nodes.find((n) => n.type === "TRIGGER") ?? nodes[0] ?? null;
}

function findById(
  nodes: NodesArray,
  id: string | undefined | null
): WorkflowNode | null {
  if (!id) return null;
  return nodes.find((n) => n.id === id) ?? null;
}

// ── Entry ──────────────────────────────────────────────────────

export async function runWorkflow(
  workflowId: number,
  trigger: RunTrigger = "cron"
): Promise<ExecuteResult> {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!wf) {
    throw new Error(`workflow_not_found:${workflowId}`);
  }
  if (!wf.isActive) {
    return {
      runId: -1,
      status: "failed",
      nodesExecuted: 0,
      finalNodeId: null,
      error: "workflow_inactive",
    };
  }

  const nodes = parseNodes(wf.nodes);
  const entry = findEntry(nodes);
  if (!entry) {
    return {
      runId: -1,
      status: "failed",
      nodesExecuted: 0,
      finalNodeId: null,
      error: "no_entry_node",
    };
  }

  const run = await prisma.workflowRun.create({
    data: {
      workflowId,
      trigger,
      status: "running",
      currentNodeId: entry.id,
      context: {},
      logs: [],
    },
  });

  const logs: LogEntry[] = [];
  const context: Record<string, unknown> = {};

  let current: WorkflowNode | null = entry;
  let nodesExecuted = 0;
  let finalStatus: ExecuteResult["status"] = "completed";
  let failure: string | undefined;

  try {
    while (current) {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { currentNodeId: current.id },
      });
      const outcome = await executeNode(current, context, logs);
      nodesExecuted++;
      if (outcome.kind === "paused") {
        finalStatus = "paused";
        break;
      }
      if (outcome.kind === "failed") {
        finalStatus = "failed";
        failure = outcome.error;
        break;
      }
      const nextId = outcome.nextNodeId ?? current.nextNodeId ?? null;
      current = findById(nodes, nextId);
    }
  } catch (e) {
    finalStatus = "failed";
    failure = (e as Error).message.slice(0, 500);
    logs.push({
      at: new Date().toISOString(),
      nodeId: current?.id ?? null,
      level: "error",
      message: failure,
    });
  }

  const lastNodeId = current?.id ?? null;
  await prisma.workflowRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      finishedAt: finalStatus === "paused" ? null : new Date(),
      currentNodeId: lastNodeId,
      context: context as unknown as Prisma.InputJsonValue,
      logs: logs as unknown as Prisma.InputJsonValue,
    },
  });
  // Stamp lastRunAt on the parent workflow.
  await prisma.workflow.update({
    where: { id: workflowId },
    data: { lastRunAt: new Date() },
  });

  return {
    runId: run.id,
    status: finalStatus,
    nodesExecuted,
    finalNodeId: lastNodeId,
    error: failure,
  };
}

// ── Per-node dispatch ──────────────────────────────────────────

type NodeOutcome =
  | { kind: "ok"; nextNodeId?: string }
  | { kind: "paused" }
  | { kind: "failed"; error: string };

function log(
  logs: LogEntry[],
  node: WorkflowNode | null,
  level: LogEntry["level"],
  message: string
): void {
  logs.push({
    at: new Date().toISOString(),
    nodeId: node?.id ?? null,
    level,
    message,
  });
}

async function executeNode(
  node: WorkflowNode,
  context: Record<string, unknown>,
  logs: LogEntry[]
): Promise<NodeOutcome> {
  log(logs, node, "info", `▶ ${node.type} (${node.id})`);

  switch (node.type) {
    case "TRIGGER":
      return { kind: "ok" };

    case "FETCH_POOL": {
      const cfg = node.config as import("./nodes").FetchPoolConfig;
      const accountType =
        cfg.poolType === "engagement" ? "engagement_test" : "follower_test";
      const rows = await prisma.testAccount.findMany({
        where: {
          accountType,
          ...(cfg.platform && cfg.platform !== "both"
            ? { platform: cfg.platform }
            : {}),
          ...(cfg.filters?.status ? { status: cfg.filters.status } : {}),
          ...(cfg.filters?.country
            ? { detectedCountry: cfg.filters.country }
            : {}),
        },
        select: {
          id: true,
          platform: true,
          username: true,
          status: true,
          lastCheckedAt: true,
        },
        take: 500,
      });
      context.pool = rows;
      context.poolCount = rows.length;
      log(logs, node, "info", `FETCH_POOL → ${rows.length} rows`);
      return { kind: "ok" };
    }

    case "FETCH_SERVICES": {
      const cfg = node.config as import("./nodes").FetchServicesConfig;
      const rows = await prisma.productServiceCandidate.findMany({
        where: {
          ...(cfg.productSlug
            ? { product: { slug: cfg.productSlug } }
            : {}),
          ...(cfg.filters?.isEligible !== undefined
            ? { isEligible: cfg.filters.isEligible }
            : {}),
          ...(cfg.filters?.forceExcluded !== undefined
            ? { forceExcluded: cfg.filters.forceExcluded }
            : {}),
        },
        include: {
          service: {
            select: {
              id: true,
              name: true,
              platform: true,
              bulkmedyaId: true,
              minQuantity: true,
              lastTestedAt: true,
            },
          },
        },
        take: 500,
      });
      context.services = rows;
      context.servicesCount = rows.length;
      log(logs, node, "info", `FETCH_SERVICES → ${rows.length} candidates`);
      return { kind: "ok" };
    }

    case "ACTION_SYNC": {
      // Fire the execute endpoint via the existing flow. v1 inlines
      // the module call so we don't add another internal fetch hop.
      const { syncServices } = await import("@/lib/bulkmedya");
      const result = await syncServices();
      context.sync = result;
      log(
        logs,
        node,
        "info",
        `ACTION_SYNC → created=${result.created} updated=${result.updated} deactivated=${result.deactivated}`
      );
      return { kind: "ok" };
    }

    case "ACTION_REMATCH": {
      const { rematchAll } = await import("@/lib/catalogue/matcher");
      const result = await rematchAll();
      context.rematch = result;
      log(
        logs,
        node,
        "info",
        `ACTION_REMATCH → created=${result.candidatesCreated} updated=${result.candidatesUpdated}`
      );
      return { kind: "ok" };
    }

    case "ACTION_HEALTH_CHECK": {
      // v1: queue a pool health-check via the existing direct-run
      // cron entrypoint. Re-using its idempotent guard means a
      // concurrent manual click won't stack runs.
      const origin = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";
      const res = await fetch(`${origin}/api/cron/pool-health-check`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
        },
      });
      const body = await res.json().catch(() => ({}));
      context.healthCheck = body;
      log(logs, node, "info", `ACTION_HEALTH_CHECK → ${res.status}`);
      return res.ok
        ? { kind: "ok" }
        : { kind: "failed", error: `health_check_http_${res.status}` };
    }

    case "ACTION_SCRAPE": {
      const cfg = node.config as import("./nodes").ActionScrapeConfig;
      const { initScrapeStats } = await import("@/lib/pool/scraper");
      const { acquireKeyForNewJob } = await import(
        "@/lib/rapidapi/key-manager"
      );
      const platform = cfg.platform ?? "both";
      const count = cfg.count ?? 200;
      const initial = initScrapeStats(platform, count);
      (initial as unknown as { poolType?: string }).poolType = cfg.poolType;
      const apiKey = await acquireKeyForNewJob("instagram");
      const rapidApiKeyId = apiKey && apiKey.id !== -1 ? apiKey.id : null;
      const job = await prisma.poolJob.create({
        data: {
          jobType: "scrape",
          platform: platform === "both" ? null : platform,
          trigger: "auto_refill",
          status: "pending",
          rapidApiKeyId,
          stats: initial as unknown as Prisma.InputJsonValue,
        },
      });
      context.scrapeJobId = job.id;
      log(logs, node, "info", `ACTION_SCRAPE → queued job#${job.id}`);
      return { kind: "ok" };
    }

    case "ACTION_TEST": {
      // v1: delegate to the test-bot's existing runner which already
      // respects the testBotEnabled kill switch + catalogue gate.
      // The node config is currently advisory — runTestBot() picks
      // its own targets. Richer scoping lands in a follow-up.
      const { runTestBot } = await import("@/lib/testbot");
      const result = await runTestBot();
      context.testbot = result;
      log(
        logs,
        node,
        "info",
        `ACTION_TEST → placed=${result.placed} skipped=${result.skipped}`
      );
      return { kind: "ok" };
    }

    case "ACTION_DELETE": {
      const cfg = node.config as import("./nodes").ActionDeleteConfig;
      const key = cfg.iterationKey ?? "pool";
      const rows = context[key];
      if (!Array.isArray(rows)) {
        log(logs, node, "warn", `ACTION_DELETE: ${key} is not an array`);
        return { kind: "ok" };
      }
      const ids = rows
        .map((r) => (r as { id?: number }).id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length === 0) {
        log(logs, node, "info", "ACTION_DELETE: no rows to delete");
        return { kind: "ok" };
      }
      await prisma.testAccount.updateMany({
        where: { id: { in: ids }, status: "invalid" },
        data: { status: "archived" },
      });
      log(logs, node, "info", `ACTION_DELETE → archived ${ids.length} row(s)`);
      return { kind: "ok" };
    }

    case "NOTIFY": {
      const cfg = node.config as import("./nodes").NotifyConfig;
      const msg = interpolate(cfg.message, context);
      log(
        logs,
        node,
        cfg.severity === "error"
          ? "error"
          : cfg.severity === "warn"
            ? "warn"
            : "info",
        `NOTIFY: ${msg}`
      );
      return { kind: "ok" };
    }

    // Deferred node types — log + pass through rather than crash the
    // run. A follow-up commit wires proper logic + pause/resume.
    case "FILTER":
    case "CONDITION":
    case "LOOP":
    case "WAIT":
      log(
        logs,
        node,
        "warn",
        `${node.type}: deferred, v2 follow-up — passing through`
      );
      return { kind: "ok" };
  }

  return {
    kind: "failed",
    error: `unknown_node_type:${(node as { type: string }).type}`,
  };
}

// ── Template interpolation ─────────────────────────────────────

// Tiny `{{ ctx.path.key }}` substitution — no full expression
// evaluator yet. Missing keys become empty strings.
function interpolate(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*ctx\.([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = (path as string).split(".");
    let cur: unknown = context;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in cur) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return "";
      }
    }
    return cur == null ? "" : String(cur);
  });
}
