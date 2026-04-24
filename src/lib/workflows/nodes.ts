// Workflow node schema. Everything a node can be is listed here so
// the editor UI can render a per-type config form + the executor
// can dispatch based on node.type. Keep this file the single source
// of truth — adding a new node type is a 3-step change:
//   1. Add it to NodeType below
//   2. Add its config shape to NodeConfig
//   3. Add a case in executor.ts:executeNode
//
// A Workflow.nodes payload is an array of WorkflowNode rows; a
// linear flow just chains via nextNodeId. Branching nodes (CONDITION,
// LOOP) carry extra {then/else} or {body/after} ids.

export type NodeType =
  | "TRIGGER"
  | "FETCH_POOL"
  | "FETCH_SERVICES"
  | "FILTER"
  | "ACTION_HEALTH_CHECK"
  | "ACTION_SCRAPE"
  | "ACTION_TEST"
  | "ACTION_SYNC"
  | "ACTION_REMATCH"
  | "ACTION_DELETE"
  | "WAIT"
  | "CONDITION"
  | "LOOP"
  | "NOTIFY";

// Every config lives under `WorkflowNode.config: Json` — we declare
// the shapes here but don't narrow them at the column level. The
// executor validates at dispatch (throws "invalid_node_config" if
// malformed).

export type TriggerConfig = Record<string, never>;
// No runtime config for trigger — the Workflow row's triggerType /
// cronExpression / eventType carries the scheduling.

export type FetchPoolConfig = {
  poolType: "follower" | "engagement";
  platform?: "instagram" | "tiktok" | "both";
  filters?: {
    status?: string;
    country?: string;
  };
};

export type FetchServicesConfig = {
  productSlug?: string;
  filters?: {
    isEligible?: boolean;
    forceExcluded?: boolean;
  };
};

export type FilterConfig = {
  field: string;
  // Minimal operator set v1 — extend as needed. Expression evaluator
  // over context variables is deferred.
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "contains";
  value: string | number | boolean | null | Array<string | number>;
};

export type ActionHealthCheckConfig = {
  // 'all' = both universes. Falls back to the 6h cron's default.
  scope?: "follower" | "engagement" | "all";
};

export type ActionScrapeConfig = {
  poolType: "follower" | "engagement";
  platform?: "instagram" | "tiktok" | "both";
  count?: number;
};

export type ActionTestConfig = {
  productSlug?: string;
  serviceIds?: number[];
  // Override the Service.minQuantity default for this test pass.
  quantityOverride?: number;
};

export type ActionSyncConfig = Record<string, never>;

export type ActionRematchConfig = Record<string, never>;

export type ActionDeleteConfig = {
  // The target `FETCH_*` node feeds rows into context; this
  // references which context key to iterate. "rows" by default.
  iterationKey?: string;
};

export type WaitConfig = {
  // One of {hours, days}. Executor paused-state serialization is
  // deferred (see executor.ts) — v1 raises "not_implemented" and
  // the runner moves on.
  unit: "minutes" | "hours" | "days";
  value: number;
};

export type ConditionConfig = {
  expression: string;
  thenNodeId: string;
  elseNodeId?: string;
};

export type LoopConfig = {
  // Iterates the array under this context key, binding each item to
  // `iterationVar` during the loop body.
  iterationKey?: string;
  iterationVar: string;
  bodyNodeId: string;
  afterNodeId?: string;
};

export type NotifyConfig = {
  // Tokens like {{ ctx.pool.count }} expanded at emit time.
  message: string;
  severity?: "info" | "warn" | "error";
};

export type NodeConfigMap = {
  TRIGGER: TriggerConfig;
  FETCH_POOL: FetchPoolConfig;
  FETCH_SERVICES: FetchServicesConfig;
  FILTER: FilterConfig;
  ACTION_HEALTH_CHECK: ActionHealthCheckConfig;
  ACTION_SCRAPE: ActionScrapeConfig;
  ACTION_TEST: ActionTestConfig;
  ACTION_SYNC: ActionSyncConfig;
  ACTION_REMATCH: ActionRematchConfig;
  ACTION_DELETE: ActionDeleteConfig;
  WAIT: WaitConfig;
  CONDITION: ConditionConfig;
  LOOP: LoopConfig;
  NOTIFY: NotifyConfig;
};

export type WorkflowNode<T extends NodeType = NodeType> = {
  id: string;
  type: T;
  config: NodeConfigMap[T];
  nextNodeId?: string;
  // Hints for the read-only graph renderer — optional, purely
  // presentational.
  label?: string;
};

// Shape of the Workflow.nodes JSON column.
export type NodesArray = WorkflowNode[];
