// Workflow execution engine.
//
// Entry points:
//   • runWorkflow(workflowId, trigger, {sourceEventId?, initialContext?})
//     — fires a fresh run, advances nodes until terminal / pause.
//   • resumePausedRun(runId) — picks up a paused run at currentNodeId.
//
// Full node support matrix:
//   ✓ TRIGGER              pass-through, advances to nextNodeId
//   ✓ FETCH_POOL           populates context.pool
//   ✓ FETCH_SERVICES       populates context.services
//   ✓ ACTION_HEALTH_CHECK  inline internal fetch to pool-health-check
//   ✓ ACTION_SCRAPE        queues PoolJob(scrape, auto_refill)
//   ✓ ACTION_TEST          runTestBot()
//   ✓ ACTION_SYNC          syncServices()
//   ✓ ACTION_REMATCH       rematchAll()
//   ✓ ACTION_DELETE        archives context[iterationKey] rows
//   ✓ NOTIFY               append to run logs with {{ctx}} interpolation
//   ✓ FILTER               predicate over ctx[field] using operator
//   ✓ CONDITION            branches to thenNodeId / elseNodeId
//   ✓ LOOP                 iterates context[iterationKey], binds item
//   ✓ WAIT                 persists resumeAt, stops the run as 'paused'
//
// Pause/resume: when WAIT fires, we stamp resumeAt on the run and
// return {kind:'paused'}. The master cron's resumePausedRun picks
// rows whose resumeAt <= now, reloads context + currentNodeId, and
// jumps back into the loop at the NEXT node (the WAIT's nextNodeId).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { WorkflowNode, NodesArray } from "./nodes";

export type RunTrigger = "cron" | "manual" | "event" | "retry";

export type RunOptions = {
  sourceEventId?: number;
  initialContext?: Record<string, unknown>;
  dryRun?: boolean;
};

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
  durationMs?: number;
};

function parseNodes(raw: Prisma.JsonValue): NodesArray {
  if (!Array.isArray(raw)) return [];
  return raw as NodesArray;
}

function findEntry(nodes: NodesArray): WorkflowNode | null {
  return nodes.find((n) => n.type === "TRIGGER") ?? nodes[0] ?? null;
}

function findById(
  nodes: NodesArray,
  id: string | undefined | null
): WorkflowNode | null {
  if (!id) return null;
  return nodes.find((n) => n.id === id) ?? null;
}

// ── Entry: fresh run ───────────────────────────────────────────

export async function runWorkflow(
  workflowId: number,
  trigger: RunTrigger = "cron",
  opts: RunOptions = {}
): Promise<ExecuteResult> {
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!wf) throw new Error(`workflow_not_found:${workflowId}`);
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

  // Seed __workflowId into the context so LOOP can resolve body
  // nodes via a fresh DB read mid-walk.
  const context: Record<string, unknown> = {
    ...(opts.initialContext ?? {}),
    __workflowId: workflowId,
  };

  const run = await prisma.workflowRun.create({
    data: {
      workflowId,
      trigger,
      status: "running",
      currentNodeId: entry.id,
      context: context as unknown as Prisma.InputJsonValue,
      logs: [],
      sourceEventId: opts.sourceEventId ?? null,
    },
  });

  const result = await walk({
    runId: run.id,
    workflowId,
    nodes,
    startNode: entry,
    context,
    initialLogs: [],
    dryRun: Boolean(opts.dryRun),
  });

  await prisma.workflow.update({
    where: { id: workflowId },
    data: { lastRunAt: new Date() },
  });

  return result;
}

// ── Entry: resume a paused run ─────────────────────────────────

export async function resumePausedRun(runId: number): Promise<ExecuteResult> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`run_not_found:${runId}`);
  if (run.status !== "paused") {
    return {
      runId,
      status: run.status as ExecuteResult["status"],
      nodesExecuted: 0,
      finalNodeId: run.currentNodeId,
      error: "not_paused",
    };
  }
  const wf = await prisma.workflow.findUnique({
    where: { id: run.workflowId },
  });
  if (!wf) throw new Error(`workflow_not_found:${run.workflowId}`);

  const nodes = parseNodes(wf.nodes);
  // The currentNodeId on a paused run is the WAIT node itself. Resume
  // at its nextNodeId — we've already served the WAIT duration.
  const waitNode = findById(nodes, run.currentNodeId);
  const resumeFrom =
    findById(nodes, waitNode?.nextNodeId) ?? null;
  if (!resumeFrom) {
    // No successor — treat as completed.
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        finishedAt: new Date(),
        resumedAt: new Date(),
      },
    });
    return {
      runId,
      status: "completed",
      nodesExecuted: 0,
      finalNodeId: run.currentNodeId,
    };
  }

  const logs: LogEntry[] = Array.isArray(run.logs)
    ? (run.logs as unknown as LogEntry[])
    : [];
  const context: Record<string, unknown> =
    (run.context as unknown as Record<string, unknown>) ?? {};

  await prisma.workflowRun.update({
    where: { id: runId },
    data: {
      status: "running",
      resumedAt: new Date(),
      // Clear the resumeAt gate so the master cron doesn't re-pick.
      resumeAt: null,
    },
  });

  return walk({
    runId,
    workflowId: run.workflowId,
    nodes,
    startNode: resumeFrom,
    context,
    initialLogs: logs,
    dryRun: false,
  });
}

// ── Shared walk loop ───────────────────────────────────────────

async function walk({
  runId,
  workflowId,
  nodes,
  startNode,
  context,
  initialLogs,
  dryRun,
}: {
  runId: number;
  workflowId: number;
  nodes: NodesArray;
  startNode: WorkflowNode;
  context: Record<string, unknown>;
  initialLogs: LogEntry[];
  dryRun: boolean;
}): Promise<ExecuteResult> {
  const logs: LogEntry[] = [...initialLogs];
  let current: WorkflowNode | null = startNode;
  let nodesExecuted = 0;
  let finalStatus: ExecuteResult["status"] = "completed";
  let failure: string | undefined;

  try {
    while (current) {
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { currentNodeId: current.id },
      });
      const t0 = Date.now();
      const outcome = await executeNode(current, context, logs, { dryRun });
      const elapsed = Date.now() - t0;
      // Annotate the last log entry with duration — trivial, but
      // gives the timeline a per-node ms number.
      if (logs.length > 0) logs[logs.length - 1].durationMs = elapsed;
      nodesExecuted++;

      if (outcome.kind === "paused") {
        finalStatus = "paused";
        // Persist resume state on the run. Note: currentNodeId is
        // the WAIT node itself — on resume we advance to its nextNodeId.
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: "paused",
            pausedAt: new Date(),
            resumeAt: outcome.resumeAt,
            context: context as unknown as Prisma.InputJsonValue,
            logs: logs as unknown as Prisma.InputJsonValue,
          },
        });
        return {
          runId,
          status: "paused",
          nodesExecuted,
          finalNodeId: current.id,
        };
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
  // 'paused' exits via return inside the loop, so by here we're
  // always on completed / failed / running — stamp a finishedAt.
  await prisma.workflowRun.update({
    where: { id: runId },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
      currentNodeId: lastNodeId,
      context: context as unknown as Prisma.InputJsonValue,
      logs: logs as unknown as Prisma.InputJsonValue,
    },
  });

  // Tell parent workflow this ran.
  await prisma.workflow.update({
    where: { id: workflowId },
    data: { lastRunAt: new Date() },
  });

  return {
    runId,
    status: finalStatus,
    nodesExecuted,
    finalNodeId: lastNodeId,
    error: failure,
  };
}

// ── Per-node dispatch ──────────────────────────────────────────

type NodeOutcome =
  | { kind: "ok"; nextNodeId?: string }
  | { kind: "paused"; resumeAt: Date }
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
  logs: LogEntry[],
  exec: { dryRun: boolean }
): Promise<NodeOutcome> {
  log(logs, node, "info", `▶ ${node.type} (${node.id})`);

  // Under dryRun, only FETCH / FILTER / CONDITION / LOOP / NOTIFY run
  // normally. All ACTION_* nodes skip their side effect but still
  // log what they *would* have done — useful for "TESTER EN DRY RUN"
  // from the editor UI.
  if (exec.dryRun && node.type.startsWith("ACTION_")) {
    log(logs, node, "info", `[dry-run] skipped side effect`);
    return { kind: "ok" };
  }

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
          invalidatedAt: true,
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

    case "FILTER": {
      const cfg = node.config as import("./nodes").FilterConfig;
      // FILTER operates on the primary collection in context —
      // preferring context.pool or context.services. The config's
      // `field` is the attribute on each row to compare; it can also
      // be a top-level context key like "poolCount" for scalar
      // checks (used by the refill flows).
      const scalar = context[cfg.field];
      if (scalar !== undefined) {
        const pass = compare(scalar, cfg.operator, cfg.value);
        log(
          logs,
          node,
          "info",
          `FILTER scalar ${cfg.field} ${cfg.operator} ${JSON.stringify(cfg.value)} → ${pass}`
        );
        if (!pass) {
          // Halt the chain cleanly — no more nextNodeId. The walk
          // loop will treat a null next as terminal.
          return { kind: "ok", nextNodeId: "__HALT__" };
        }
        return { kind: "ok" };
      }
      // Collection filter — apply element-wise to pool or services.
      const key = Array.isArray(context.pool)
        ? "pool"
        : Array.isArray(context.services)
          ? "services"
          : null;
      if (!key) {
        log(logs, node, "warn", `FILTER: no collection to filter in context`);
        return { kind: "ok" };
      }
      const before = (context[key] as unknown[]).length;
      const filtered = (context[key] as Array<Record<string, unknown>>).filter(
        (row) => compare(row[cfg.field], cfg.operator, cfg.value)
      );
      context[key] = filtered;
      if (key === "pool") context.poolCount = filtered.length;
      if (key === "services") context.servicesCount = filtered.length;
      log(
        logs,
        node,
        "info",
        `FILTER ${key}.${cfg.field} ${cfg.operator} ${JSON.stringify(cfg.value)} → ${before} → ${filtered.length}`
      );
      return { kind: "ok" };
    }

    case "CONDITION": {
      const cfg = node.config as import("./nodes").ConditionConfig;
      // Minimal expression: "ctx.<path> <op> <value>". The exhaustive
      // AND/OR grammar is TODO but the seeds below only need single
      // comparisons.
      const match = cfg.expression.match(
        /^\s*ctx\.([\w.]+)\s*(==|!=|<=|>=|<|>|contains|in)\s*(.+?)\s*$/
      );
      if (!match) {
        log(
          logs,
          node,
          "error",
          `CONDITION: unable to parse expression "${cfg.expression}"`
        );
        return { kind: "failed", error: "condition_parse_error" };
      }
      const [, path, op, rawVal] = match;
      const lhs = readPath(context, path);
      const rhs = parseLiteral(rawVal);
      const pass = compare(lhs, op, rhs);
      const nextId = pass ? cfg.thenNodeId : cfg.elseNodeId;
      log(
        logs,
        node,
        "info",
        `CONDITION "${cfg.expression}" → ${pass} → ${nextId ?? "<end>"}`
      );
      return { kind: "ok", nextNodeId: nextId };
    }

    case "LOOP": {
      const cfg = node.config as import("./nodes").LoopConfig;
      const key = cfg.iterationKey ?? "services";
      const arr = context[key];
      if (!Array.isArray(arr)) {
        log(logs, node, "warn", `LOOP: ${key} is not an array — skipping`);
        return { kind: "ok", nextNodeId: cfg.afterNodeId };
      }
      const max = 1000;
      const items = arr.slice(0, max);
      log(
        logs,
        node,
        "info",
        `LOOP over ${items.length} item(s) (key=${key}, var=${cfg.iterationVar})`
      );
      // v1 loop = iterate + execute the body synchronously. We
      // record per-iteration logs but don't spawn separate runs.
      // Fetch the caller's node list via a closure — not available
      // here; we walk by looking up body target + following its
      // nextNodeId chain until we hit a node whose id is `afterNodeId`
      // or the chain ends. This supports simple linear loop bodies.
      // Complex nested graphs would need a separate sub-walk.
      // For the current seed flows (single ACTION_TEST inside the
      // loop body) this is sufficient.
      // Body execution: stash the current item under
      // context[iterationVar] and recursively execute via the walk
      // loop. We do this by returning a special nextNodeId that the
      // outer walk can recognise — but since LOOP runs inline, we
      // simulate it here via a sub-walk using prisma re-reads of
      // the workflow.
      // For brevity + safety the v1 executor doesn't support
      // user-defined body chains beyond the declared bodyNodeId; we
      // call executeNode on that body per iteration.
      // Look up the target node from the caller's nodes — we need
      // the nodes array. LoopConfig doesn't give it, so we accept
      // that v1 LOOP only works when bodyNodeId points to a node
      // that can be evaluated standalone (eg. an ACTION_TEST).
      // Advanced nested loops: v3.
      const bodyId = cfg.bodyNodeId;
      if (!bodyId) {
        log(logs, node, "warn", "LOOP: no bodyNodeId — skipping iterations");
        return { kind: "ok", nextNodeId: cfg.afterNodeId };
      }
      // Re-read the workflow.nodes so we can resolve bodyNodeId.
      // The run's workflowId is passed via context.__workflowId
      // (seeded below). If missing, degrade gracefully.
      const wfId = context.__workflowId as number | undefined;
      if (!wfId) {
        log(logs, node, "warn", "LOOP: workflow context missing, skipping");
        return { kind: "ok", nextNodeId: cfg.afterNodeId };
      }
      const fresh = await prisma.workflow.findUnique({ where: { id: wfId } });
      if (!fresh) {
        return { kind: "failed", error: "loop_workflow_vanished" };
      }
      const allNodes = parseNodes(fresh.nodes);
      const body = allNodes.find((n) => n.id === bodyId);
      if (!body) {
        log(logs, node, "warn", `LOOP: bodyNodeId ${bodyId} not found`);
        return { kind: "ok", nextNodeId: cfg.afterNodeId };
      }
      for (let i = 0; i < items.length; i++) {
        context[cfg.iterationVar] = items[i];
        context.__loopIndex = i;
        const r = await executeNode(body, context, logs, exec);
        if (r.kind === "failed") return r;
        if (r.kind === "paused") {
          // Pausing mid-loop is not supported in v1. Log + bail.
          log(logs, node, "warn", "LOOP: WAIT inside body not supported v1");
          return { kind: "ok", nextNodeId: cfg.afterNodeId };
        }
      }
      delete context[cfg.iterationVar];
      delete context.__loopIndex;
      return { kind: "ok", nextNodeId: cfg.afterNodeId };
    }

    case "WAIT": {
      const cfg = node.config as import("./nodes").WaitConfig;
      const unitMs =
        cfg.unit === "days"
          ? 24 * 60 * 60_000
          : cfg.unit === "hours"
            ? 60 * 60_000
            : 60_000;
      const resumeAt = new Date(Date.now() + cfg.value * unitMs);
      log(
        logs,
        node,
        "info",
        `WAIT ${cfg.value} ${cfg.unit} → resume at ${resumeAt.toISOString()}`
      );
      return { kind: "paused", resumeAt };
    }

    case "ACTION_SYNC": {
      const { syncServices } = await import("@/lib/bulkmedya");
      const result = await syncServices();
      context.sync = result;
      log(
        logs,
        node,
        "info",
        `ACTION_SYNC → created=${result.created} updated=${result.updated} deactivated=${result.deactivated}`
      );
      // Emit services.synced so the catalogue rematch workflow picks
      // up. Best-effort.
      const { emit } = await import("./events");
      await emit("services.synced", { result });
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
  }

  return {
    kind: "failed",
    error: `unknown_node_type:${(node as { type: string }).type}`,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function readPath(
  root: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // Quoted string "foo" or 'foo'
  const m = trimmed.match(/^(?:"([^"]*)"|'([^']*)')$/);
  if (m) return m[1] ?? m[2] ?? "";
  // Array literal [a, b, c]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function compare(
  lhs: unknown,
  op: string,
  rhs: unknown
): boolean {
  if (op === "==" || op === "eq") return lhs === rhs;
  if (op === "!=" || op === "ne") return lhs !== rhs;
  if (op === "contains") {
    if (typeof lhs === "string" && typeof rhs === "string")
      return lhs.includes(rhs);
    if (Array.isArray(lhs)) return lhs.includes(rhs);
    return false;
  }
  if (op === "in") {
    if (Array.isArray(rhs)) return rhs.includes(lhs);
    return false;
  }
  // Numeric-ish compare
  const ln = typeof lhs === "number" ? lhs : lhs == null ? null : Number(lhs);
  const rn = typeof rhs === "number" ? rhs : rhs == null ? null : Number(rhs);
  if (ln === null || rn === null || Number.isNaN(ln) || Number.isNaN(rn)) {
    // Null comparisons for "lt/lte/gt/gte" — null is treated as
    // "missing" which matches most SQL engines' NULL-as-least-value
    // semantics for lt/lte.
    if (lhs === null) return op === "lt" || op === "lte";
    return false;
  }
  switch (op) {
    case "<":
    case "lt":
      return ln < rn;
    case "<=":
    case "lte":
      return ln <= rn;
    case ">":
    case "gt":
      return ln > rn;
    case ">=":
    case "gte":
      return ln >= rn;
  }
  return false;
}

function interpolate(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*ctx\.([\w.]+)\s*\}\}/g, (_, path) => {
    const v = readPath(context, path as string);
    return v == null ? "" : String(v);
  });
}
