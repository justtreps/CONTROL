"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node as RFNode,
  type NodeTypes,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import { useRouter } from "next/navigation";
import type { NodeType, NodesArray, WorkflowNode } from "@/lib/workflows/nodes";

// ── Node type catalog + palette ────────────────────────────────

const ALL_NODE_TYPES: NodeType[] = [
  "TRIGGER",
  "FETCH_POOL",
  "FETCH_SERVICES",
  "FILTER",
  "CONDITION",
  "LOOP",
  "WAIT",
  "ACTION_HEALTH_CHECK",
  "ACTION_SCRAPE",
  "ACTION_TEST",
  "ACTION_SYNC",
  "ACTION_REMATCH",
  "ACTION_DELETE",
  "NOTIFY",
];

const NODE_COLOR: Record<NodeType, string> = {
  TRIGGER: "#FF3300",
  FETCH_POOL: "#66CCFF",
  FETCH_SERVICES: "#66CCFF",
  FILTER: "#FFCC00",
  CONDITION: "#FFCC00",
  LOOP: "#FFCC00",
  WAIT: "#FF66CC",
  ACTION_HEALTH_CHECK: "#00CC66",
  ACTION_SCRAPE: "#00CC66",
  ACTION_TEST: "#00CC66",
  ACTION_SYNC: "#00CC66",
  ACTION_REMATCH: "#00CC66",
  ACTION_DELETE: "#00CC66",
  NOTIFY: "#CCCCCC",
};

const DEFAULT_CONFIG: Record<NodeType, Record<string, unknown>> = {
  TRIGGER: {},
  FETCH_POOL: { poolType: "follower", platform: "both" },
  FETCH_SERVICES: { filters: { isEligible: true, forceExcluded: false } },
  FILTER: { field: "poolCount", operator: "lt", value: 500 },
  CONDITION: {
    expression: "ctx.poolCount < 500",
    thenNodeId: "",
    elseNodeId: "",
  },
  LOOP: {
    iterationKey: "services",
    iterationVar: "item",
    bodyNodeId: "",
    afterNodeId: "",
  },
  WAIT: { unit: "hours", value: 6 },
  ACTION_HEALTH_CHECK: { scope: "follower" },
  ACTION_SCRAPE: { poolType: "follower", platform: "both", count: 500 },
  ACTION_TEST: {},
  ACTION_SYNC: {},
  ACTION_REMATCH: {},
  ACTION_DELETE: { iterationKey: "pool" },
  NOTIFY: { message: "", severity: "info" },
};

// ── Visual node component — brutalist block with Handle anchors ─

function BrutalistNode({
  data,
}: {
  data: { node: WorkflowNode; onClick: (id: string) => void };
}) {
  const n = data.node;
  const color = NODE_COLOR[n.type] ?? "#CCCCCC";
  return (
    <div
      className="interactive font-mono text-xs uppercase tracking-widest bg-[#030303] border-2 hover:border-white transition-colors"
      style={{ borderColor: color, minWidth: 220 }}
      onClick={() => data.onClick(n.id)}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: color, width: 8, height: 8, borderRadius: 0 }}
      />
      <div
        className="px-2 py-1 text-black text-[10px] tracking-widest"
        style={{ backgroundColor: color }}
      >
        {n.type}
      </div>
      <div className="px-3 py-2 flex flex-col gap-1">
        <div className="text-white">{n.label ?? n.id}</div>
        <div className="text-[#666666] text-[10px] tracking-wide normal-case">
          {summariseConfig(n)}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: color, width: 8, height: 8, borderRadius: 0 }}
      />
    </div>
  );
}

function summariseConfig(n: WorkflowNode): string {
  const c = n.config as Record<string, unknown>;
  if (!c) return "";
  const bits: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (v == null) continue;
    if (typeof v === "object" && Object.keys(v).length === 0) continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    bits.push(`${k}=${s.length > 32 ? s.slice(0, 29) + "…" : s}`);
  }
  return bits.join(" · ");
}

// ── Editor ─────────────────────────────────────────────────────

export function WorkflowEditor({
  slug,
  initialNodes,
  readOnly,
}: {
  slug: string;
  initialNodes: NodesArray;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Working copy of the WorkflowNode[] — the source of truth for save.
  const [nodes, setNodes] = useState<NodesArray>(initialNodes);

  // Auto-layout positions: column, 200px apart vertically. User can
  // drag afterwards; positions ARE persisted in the editor state but
  // intentionally NOT round-tripped to DB — the stored format stays
  // the minimal NodesArray. Visual positions re-derive on reload.
  const autoLayout = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    initialNodes.forEach((n, i) => {
      map.set(n.id, { x: 80, y: 40 + i * 140 });
    });
    return map;
  }, [initialNodes]);

  const rfNodeTypes: NodeTypes = useMemo(
    () => ({ brutal: BrutalistNode }),
    []
  );

  // Derived RF state — rebuilt when the logical nodes array changes.
  const rfInitial = useMemo(() => {
    const rfNodes: RFNode[] = nodes.map((n) => ({
      id: n.id,
      type: "brutal",
      position: autoLayout.get(n.id) ?? { x: 80, y: 40 },
      data: {
        node: n,
        onClick: (id: string) => setSelectedNodeId(id),
      },
    }));
    const rfEdges: Edge[] = [];
    for (const n of nodes) {
      if (n.nextNodeId)
        rfEdges.push({
          id: `${n.id}-${n.nextNodeId}`,
          source: n.id,
          target: n.nextNodeId,
          style: { stroke: "#FF3300", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#FF3300" },
          type: "step", // angular (brutalist), not bezier
        });
      if (n.type === "CONDITION") {
        const c = n.config as import("@/lib/workflows/nodes").ConditionConfig;
        if (c.thenNodeId)
          rfEdges.push({
            id: `${n.id}-then-${c.thenNodeId}`,
            source: n.id,
            target: c.thenNodeId,
            label: "THEN",
            labelStyle: { fill: "#00CC66", fontSize: 10, fontFamily: "monospace" },
            style: { stroke: "#00CC66", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#00CC66" },
            type: "step",
          });
        if (c.elseNodeId)
          rfEdges.push({
            id: `${n.id}-else-${c.elseNodeId}`,
            source: n.id,
            target: c.elseNodeId,
            label: "ELSE",
            labelStyle: { fill: "#FFCC00", fontSize: 10, fontFamily: "monospace" },
            style: { stroke: "#FFCC00", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#FFCC00" },
            type: "step",
          });
      }
      if (n.type === "LOOP") {
        const c = n.config as import("@/lib/workflows/nodes").LoopConfig;
        if (c.bodyNodeId)
          rfEdges.push({
            id: `${n.id}-body-${c.bodyNodeId}`,
            source: n.id,
            target: c.bodyNodeId,
            label: "BODY",
            labelStyle: { fill: "#FFCC00", fontSize: 10, fontFamily: "monospace" },
            style: { stroke: "#FFCC00", strokeWidth: 2, strokeDasharray: "4 4" },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#FFCC00" },
            type: "step",
          });
      }
    }
    return { rfNodes, rfEdges };
  }, [nodes, autoLayout]);

  const [rfNodes, setRFNodes, onNodesChange] = useNodesState(rfInitial.rfNodes);
  const [rfEdges, setRFEdges, onEdgesChange] = useEdgesState(rfInitial.rfEdges);

  // Re-sync RF state whenever our logical nodes change (eg. after
  // adding a node from the palette).
  useEffect(() => {
    setRFNodes(rfInitial.rfNodes);
    setRFEdges(rfInitial.rfEdges);
  }, [rfInitial, setRFNodes, setRFEdges]);

  // Dragging two handles together → append nextNodeId on source.
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === c.source ? { ...n, nextNodeId: c.target ?? undefined } : n
        )
      );
      setRFEdges((eds) =>
        addEdge(
          {
            ...c,
            type: "step",
            style: { stroke: "#FF3300", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#FF3300" },
          },
          eds
        )
      );
      setDirty(true);
    },
    [setRFEdges]
  );

  // Keyboard: Delete → remove the selected node.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
        if ((e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/i))
          return;
        removeNode(selectedNodeId);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  function removeNode(id: string) {
    setNodes((prev) =>
      prev
        .filter((n) => n.id !== id)
        .map((n) =>
          n.nextNodeId === id ? { ...n, nextNodeId: undefined } : n
        )
    );
    setSelectedNodeId(null);
    setDirty(true);
  }

  function addNode(type: NodeType) {
    const id = `n_${Math.random().toString(36).slice(2, 8)}`;
    setNodes((prev) => [
      ...prev,
      {
        id,
        type,
        config: DEFAULT_CONFIG[type] as never,
        label: type.toLowerCase().replace(/_/g, " "),
      },
    ]);
    setShowPalette(false);
    setDirty(true);
  }

  function patchSelected(patch: Partial<WorkflowNode>) {
    if (!selectedNodeId) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === selectedNodeId ? ({ ...n, ...patch } as WorkflowNode) : n
      )
    );
    setDirty(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setFlash("SAUVEGARDE…");
    try {
      const res = await fetch(`/api/workflows/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes }),
      });
      if (res.ok) {
        setDirty(false);
        setFlash("SAUVEGARDÉ");
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        const details = Array.isArray(body.details)
          ? body.details.join(", ")
          : body.error ?? "erreur";
        setFlash(`ÉCHEC: ${details}`);
      }
    } finally {
      setSaving(false);
      setTimeout(() => setFlash(null), 4500);
    }
  }

  const selected = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <ReactFlowProvider>
      <div className="relative" style={{ height: "75vh" }}>
        <div className="absolute inset-0">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={rfNodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#222222" />
            <Controls
              className="!bg-[#0D0D0D] !border !border-[#666666]/40"
              showInteractive={false}
            />
            <MiniMap
              nodeColor={(n) => {
                const t = (n.data as { node?: WorkflowNode })?.node?.type;
                return t ? NODE_COLOR[t] : "#666666";
              }}
              maskColor="rgba(0,0,0,0.6)"
              style={{
                background: "#030303",
                border: "1px solid rgba(102,102,102,0.4)",
              }}
            />
          </ReactFlow>
        </div>

        {/* Top-left toolbar */}
        <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowPalette(true)}
            disabled={readOnly}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
          >
            [ + AJOUTER NODE ]
          </button>
          <button
            type="button"
            onClick={save}
            disabled={readOnly || saving || !dirty}
            className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
          >
            {saving ? "[ SAUVE… ]" : dirty ? "[ SAUVEGARDER ]" : "[ PAS DE CHGT ]"}
          </button>
          <button
            type="button"
            onClick={() => router.refresh()}
            disabled={readOnly || !dirty}
            className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
          >
            [ ANNULER ]
          </button>
          {flash && (
            <span
              className={
                "interactive border px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase " +
                (flash.startsWith("ÉCHEC")
                  ? "border-[#FF3300] text-[#FF3300]"
                  : "border-[#00CC66] text-[#00CC66]")
              }
            >
              {flash}
            </span>
          )}
        </div>

        {/* Palette modal */}
        {showPalette && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setShowPalette(false)}
          >
            <div
              className="bg-[#030303] border-2 border-[#FF3300] p-6 w-[560px] max-w-[92%]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase mb-3">
                [ PALETTE ]
              </div>
              <h3 className="brand font-display text-2xl uppercase tracking-tight text-white m-0 mb-4">
                Ajouter un node
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {ALL_NODE_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => addNode(t)}
                    className="interactive text-left border-2 px-3 py-2 font-mono text-[11px] tracking-widest uppercase hover:bg-[#0D0D0D] transition-colors"
                    style={{ borderColor: NODE_COLOR[t] }}
                  >
                    <span
                      className="inline-block px-1.5 text-black mr-2"
                      style={{ backgroundColor: NODE_COLOR[t] }}
                    >
                      {t}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex justify-end mt-4">
                <button
                  type="button"
                  onClick={() => setShowPalette(false)}
                  className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
                >
                  [ FERMER ]
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Config drawer */}
      {selected && (
        <NodeConfigDrawer
          node={selected}
          allNodes={nodes}
          onPatch={patchSelected}
          onDelete={() => removeNode(selected.id)}
          onClose={() => setSelectedNodeId(null)}
          readOnly={readOnly}
        />
      )}
    </ReactFlowProvider>
  );
}

// ── Config drawer — per-type form ──────────────────────────────

function NodeConfigDrawer({
  node,
  allNodes,
  onPatch,
  onDelete,
  onClose,
  readOnly,
}: {
  node: WorkflowNode;
  allNodes: NodesArray;
  onPatch: (patch: Partial<WorkflowNode>) => void;
  onDelete: () => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const cfg = (node.config as Record<string, unknown>) ?? {};
  const setCfg = (k: string, v: unknown) =>
    onPatch({ config: { ...cfg, [k]: v } as never });
  const otherIds = allNodes.filter((n) => n.id !== node.id).map((n) => n.id);

  return (
    <div className="fixed right-0 top-0 bottom-0 w-full sm:w-[460px] z-40 bg-[#030303] border-l-2 border-[#FF3300] overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
            [ NODE · {node.id} ]
          </div>
          <h3 className="brand font-display text-xl tracking-tight uppercase text-white leading-none mt-1">
            {node.type}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="interactive font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white px-3 py-1 border border-[#666666]/40 hover:border-white transition-colors"
        >
          [ ✕ ]
        </button>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        <Field
          label="LABEL"
          value={node.label ?? ""}
          onChange={(v) => onPatch({ label: v })}
          readOnly={readOnly}
        />
        <Field
          label="ID"
          value={node.id}
          onChange={() => undefined}
          readOnly
        />

        {/* Per-type fields */}
        {node.type === "FETCH_POOL" && (
          <>
            <SelectField
              label="POOL TYPE"
              value={String(cfg.poolType ?? "follower")}
              onChange={(v) => setCfg("poolType", v)}
              options={[
                ["follower", "FOLLOWER"],
                ["engagement", "ENGAGEMENT"],
              ]}
              readOnly={readOnly}
            />
            <SelectField
              label="PLATFORM"
              value={String(cfg.platform ?? "both")}
              onChange={(v) => setCfg("platform", v)}
              options={[
                ["both", "BOTH"],
                ["instagram", "IG"],
                ["tiktok", "TT"],
              ]}
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "FETCH_SERVICES" && (
          <>
            <Field
              label="PRODUCT SLUG (OPTIONNEL)"
              value={String(cfg.productSlug ?? "")}
              onChange={(v) => setCfg("productSlug", v || undefined)}
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "FILTER" && (
          <>
            <Field
              label="FIELD"
              value={String(cfg.field ?? "")}
              onChange={(v) => setCfg("field", v)}
              readOnly={readOnly}
            />
            <SelectField
              label="OPERATOR"
              value={String(cfg.operator ?? "eq")}
              onChange={(v) => setCfg("operator", v)}
              options={[
                ["eq", "=="],
                ["ne", "!="],
                ["lt", "<"],
                ["lte", "<="],
                ["gt", ">"],
                ["gte", ">="],
                ["contains", "contains"],
                ["in", "in"],
              ]}
              readOnly={readOnly}
            />
            <Field
              label="VALUE (JSON)"
              value={JSON.stringify(cfg.value ?? null)}
              onChange={(v) => {
                try {
                  setCfg("value", JSON.parse(v));
                } catch {
                  setCfg("value", v);
                }
              }}
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "CONDITION" && (
          <>
            <Field
              label="EXPRESSION"
              value={String(cfg.expression ?? "")}
              onChange={(v) => setCfg("expression", v)}
              help="ctx.<path> <op> <valeur>"
              readOnly={readOnly}
            />
            <NodeSelectField
              label="THEN → NODE"
              value={String(cfg.thenNodeId ?? "")}
              onChange={(v) => setCfg("thenNodeId", v)}
              options={otherIds}
              readOnly={readOnly}
            />
            <NodeSelectField
              label="ELSE → NODE"
              value={String(cfg.elseNodeId ?? "")}
              onChange={(v) => setCfg("elseNodeId", v || undefined)}
              options={otherIds}
              allowEmpty
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "LOOP" && (
          <>
            <Field
              label="ITERATION KEY"
              value={String(cfg.iterationKey ?? "services")}
              onChange={(v) => setCfg("iterationKey", v)}
              readOnly={readOnly}
            />
            <Field
              label="ITERATION VAR"
              value={String(cfg.iterationVar ?? "item")}
              onChange={(v) => setCfg("iterationVar", v)}
              readOnly={readOnly}
            />
            <NodeSelectField
              label="BODY NODE"
              value={String(cfg.bodyNodeId ?? "")}
              onChange={(v) => setCfg("bodyNodeId", v)}
              options={otherIds}
              readOnly={readOnly}
            />
            <NodeSelectField
              label="AFTER NODE"
              value={String(cfg.afterNodeId ?? "")}
              onChange={(v) => setCfg("afterNodeId", v || undefined)}
              options={otherIds}
              allowEmpty
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "WAIT" && (
          <>
            <NumberField
              label="VALUE"
              value={Number(cfg.value ?? 1)}
              onChange={(v) => setCfg("value", v)}
              readOnly={readOnly}
            />
            <SelectField
              label="UNIT"
              value={String(cfg.unit ?? "hours")}
              onChange={(v) => setCfg("unit", v)}
              options={[
                ["minutes", "MINUTES"],
                ["hours", "HOURS"],
                ["days", "DAYS"],
              ]}
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "ACTION_SCRAPE" && (
          <>
            <SelectField
              label="POOL TYPE"
              value={String(cfg.poolType ?? "follower")}
              onChange={(v) => setCfg("poolType", v)}
              options={[
                ["follower", "FOLLOWER"],
                ["engagement", "ENGAGEMENT"],
              ]}
              readOnly={readOnly}
            />
            <SelectField
              label="PLATFORM"
              value={String(cfg.platform ?? "both")}
              onChange={(v) => setCfg("platform", v)}
              options={[
                ["both", "BOTH"],
                ["instagram", "IG"],
                ["tiktok", "TT"],
              ]}
              readOnly={readOnly}
            />
            <NumberField
              label="COUNT"
              value={Number(cfg.count ?? 500)}
              onChange={(v) => setCfg("count", v)}
              readOnly={readOnly}
            />
          </>
        )}
        {node.type === "ACTION_HEALTH_CHECK" && (
          <SelectField
            label="SCOPE"
            value={String(cfg.scope ?? "all")}
            onChange={(v) => setCfg("scope", v)}
            options={[
              ["all", "ALL"],
              ["follower", "FOLLOWER"],
              ["engagement", "ENGAGEMENT"],
            ]}
            readOnly={readOnly}
          />
        )}
        {node.type === "NOTIFY" && (
          <>
            <Field
              label="MESSAGE ({{ ctx.x.y }})"
              value={String(cfg.message ?? "")}
              onChange={(v) => setCfg("message", v)}
              readOnly={readOnly}
            />
            <SelectField
              label="SÉVÉRITÉ"
              value={String(cfg.severity ?? "info")}
              onChange={(v) => setCfg("severity", v)}
              options={[
                ["info", "INFO"],
                ["warn", "WARN"],
                ["error", "ERROR"],
              ]}
              readOnly={readOnly}
            />
          </>
        )}

        <Field
          label="NEXT NODE (LINÉAIRE)"
          value={String(node.nextNodeId ?? "")}
          onChange={(v) => onPatch({ nextNodeId: v || undefined })}
          help="Laisser vide pour terminer la branche ici"
          readOnly={readOnly}
        />

        {!readOnly && node.type !== "TRIGGER" && (
          <button
            type="button"
            onClick={onDelete}
            className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase self-start"
          >
            [ SUPPRIMER CE NODE ]
          </button>
        )}
      </div>
    </div>
  );
}

// ── Tiny form primitives ───────────────────────────────────────

const INPUT_CLASS =
  "interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";

function Field({
  label,
  value,
  onChange,
  help,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input
        className={INPUT_CLASS}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && (
        <span className="font-mono text-[10px] text-[#666666] normal-case leading-snug">
          {help}
        </span>
      )}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input
        type="number"
        className={INPUT_CLASS}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  readOnly?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <select
        className={INPUT_CLASS}
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function NodeSelectField({
  label,
  value,
  onChange,
  options,
  allowEmpty,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowEmpty?: boolean;
  readOnly?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <select
        className={INPUT_CLASS}
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowEmpty && <option value="">—</option>}
        {options.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}
