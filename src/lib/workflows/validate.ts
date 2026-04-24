// Workflow graph validation — called at save time (PATCH/POST) to
// refuse malformed nodes JSON before it lands in DB. Covers:
//   • must have exactly one TRIGGER node (or none → auto-accept first)
//   • no orphan ids in nextNodeId / branches
//   • no cycles (DFS with white/grey/black marking)
//   • CONDITION nodes must reference real thenNodeId (+ elseNodeId if set)
//   • LOOP nodes must reference a real bodyNodeId

import type { NodesArray } from "./nodes";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateWorkflowGraph(
  nodes: NodesArray
): ValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, errors: ["graph is empty"] };
  }
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id) errors.push(`node missing id (type=${n.type})`);
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }
  const triggerCount = nodes.filter((n) => n.type === "TRIGGER").length;
  if (triggerCount > 1) errors.push(`expected 0 or 1 TRIGGER, got ${triggerCount}`);

  const ref = (target: string | undefined | null, ctx: string) => {
    if (!target) return;
    if (!ids.has(target)) errors.push(`${ctx}: unknown node "${target}"`);
  };
  for (const n of nodes) {
    ref(n.nextNodeId, `${n.id}.nextNodeId`);
    if (n.type === "CONDITION") {
      const cfg = n.config as import("./nodes").ConditionConfig;
      ref(cfg.thenNodeId, `${n.id}.thenNodeId`);
      ref(cfg.elseNodeId, `${n.id}.elseNodeId`);
    }
    if (n.type === "LOOP") {
      const cfg = n.config as import("./nodes").LoopConfig;
      ref(cfg.bodyNodeId, `${n.id}.bodyNodeId`);
      ref(cfg.afterNodeId, `${n.id}.afterNodeId`);
    }
  }

  // Cycle detection — DFS marks. Collect all out-edges per node so
  // the CONDITION then/else + LOOP body/after are all covered.
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const edges: string[] = [];
    if (n.nextNodeId) edges.push(n.nextNodeId);
    if (n.type === "CONDITION") {
      const cfg = n.config as import("./nodes").ConditionConfig;
      if (cfg.thenNodeId) edges.push(cfg.thenNodeId);
      if (cfg.elseNodeId) edges.push(cfg.elseNodeId);
    }
    if (n.type === "LOOP") {
      const cfg = n.config as import("./nodes").LoopConfig;
      // bodyNodeId is intentionally NOT followed for cycle-detection
      // purposes — the LOOP treats its body as a sub-graph rooted at
      // bodyNodeId and runs it N times, so `body → … → loop` isn't
      // a true cycle at the DAG level. afterNodeId IS followed.
      if (cfg.afterNodeId) edges.push(cfg.afterNodeId);
    }
    out.set(n.id, edges);
  }

  const colour = new Map<string, "white" | "grey" | "black">();
  for (const n of nodes) colour.set(n.id, "white");
  const dfs = (id: string): boolean => {
    colour.set(id, "grey");
    for (const next of out.get(id) ?? []) {
      const c = colour.get(next);
      if (c === "grey") return true; // back-edge
      if (c === "white" && dfs(next)) return true;
    }
    colour.set(id, "black");
    return false;
  };
  for (const n of nodes) {
    if (colour.get(n.id) === "white" && dfs(n.id)) {
      errors.push(`cycle detected near node "${n.id}"`);
      break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
