"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NodesArray, NodeType } from "@/lib/workflows/nodes";

type Run = {
  id: number;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  currentNodeId: string | null;
  logs: Array<{
    at: string;
    nodeId: string | null;
    level: string;
    message: string;
  }>;
};

// Accent colour per node type — keeps the brutalist graph readable.
const NODE_COLOR: Partial<Record<NodeType, string>> = {
  TRIGGER: "#FF3300",
  FETCH_POOL: "#66CCFF",
  FETCH_SERVICES: "#66CCFF",
  FILTER: "#FFCC00",
  ACTION_HEALTH_CHECK: "#00CC66",
  ACTION_SCRAPE: "#00CC66",
  ACTION_TEST: "#00CC66",
  ACTION_SYNC: "#00CC66",
  ACTION_REMATCH: "#00CC66",
  ACTION_DELETE: "#00CC66",
  WAIT: "#FF66CC",
  CONDITION: "#FFCC00",
  LOOP: "#FFCC00",
  NOTIFY: "#CCCCCC",
};

export function WorkflowDetailClient({
  slug,
  isActive,
  nodes,
  initialRuns,
}: {
  slug: string;
  isActive: boolean;
  nodes: NodesArray;
  initialRuns: Run[];
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  async function refreshRuns() {
    const res = await fetch(`/api/workflows/${slug}/runs`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const d = (await res.json()) as { runs: Run[] };
    setRuns(d.runs);
  }

  async function runNow() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/workflows/${slug}/run`, { method: "POST" });
      await refreshRuns();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="px-4 md:px-8 pb-6">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3">
          <button
            type="button"
            onClick={runNow}
            disabled={busy || !isActive}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
          >
            {busy ? "[ LANCEMENT… ]" : "[ LANCER MAINTENANT ]"}
          </button>
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(true);
              void refreshRuns();
            }}
            className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase"
          >
            [ HISTORIQUE RUNS · {runs.length} ]
          </button>
          <div className="interactive border border-[#666666]/40 text-[#666666] px-4 py-2 font-mono text-xs tracking-widest uppercase cursor-not-allowed">
            [ + AJOUTER NODE · V2 ]
          </div>
        </div>
      </section>

      {/* Node graph — read-only brutalist ASCII flow */}
      <section className="px-4 md:px-8 pb-16">
        <div className="max-w-7xl mx-auto border border-[#666666]/30 bg-[#030303] p-6 md:p-10 overflow-x-auto">
          {nodes.length === 0 ? (
            <div className="font-mono text-xs text-[#666666] tracking-widest uppercase text-center py-8">
              AUCUN NODE CONFIGURÉ
            </div>
          ) : (
            <div className="flex flex-col gap-0 min-w-max">
              {nodes.map((n, idx) => {
                const color = NODE_COLOR[n.type] ?? "#CCCCCC";
                const hasNext = Boolean(n.nextNodeId) && idx < nodes.length - 1;
                return (
                  <div key={n.id} className="flex flex-col items-start">
                    <div
                      className="inline-flex items-stretch border-2 bg-[#030303]"
                      style={{ borderColor: color, minWidth: "320px" }}
                    >
                      <div
                        className="px-3 py-2 font-mono text-[10px] tracking-widest uppercase text-black"
                        style={{ backgroundColor: color }}
                      >
                        {n.type}
                      </div>
                      <div className="flex-1 px-4 py-2 flex flex-col gap-1">
                        <div className="font-mono text-xs text-white tracking-widest uppercase">
                          {n.label ?? n.id}
                        </div>
                        {formatConfig(n) && (
                          <div className="font-mono text-[10px] text-[#999999] normal-case">
                            {formatConfig(n)}
                          </div>
                        )}
                      </div>
                      <div className="px-3 py-2 font-mono text-[10px] text-[#666666] tracking-widest border-l border-[#666666]/30 self-center">
                        {n.id}
                      </div>
                    </div>
                    {hasNext && (
                      <div
                        className="pl-8 py-2 font-mono text-xl"
                        style={{ color }}
                      >
                        ▼
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* History drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Fermer"
            className="flex-1 bg-black/70 backdrop-blur-sm"
          />
          <div className="relative w-full sm:w-[700px] max-w-full bg-[#030303] border-l-2 border-[#FF3300] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
              <div className="min-w-0">
                <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
                  [ RUNS ]
                </div>
                <h3 className="brand font-display text-xl tracking-tight uppercase text-white leading-none mt-1">
                  Historique
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="interactive font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white px-3 py-1 border border-[#666666]/40 hover:border-white transition-colors"
              >
                [ ✕ ]
              </button>
            </div>
            {runs.length === 0 ? (
              <div className="px-6 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
                AUCUN RUN POUR L&apos;INSTANT
              </div>
            ) : (
              <div className="flex flex-col">
                {runs.map((r) => (
                  <div
                    key={r.id}
                    className="border-b border-[#666666]/20 px-5 py-3"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRun(expandedRun === r.id ? null : r.id)
                      }
                      className="interactive w-full text-left flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[10px] tracking-widest uppercase text-[#666666]">
                          #{r.id}
                        </span>
                        <span
                          className="font-mono text-[10px] tracking-widest uppercase border px-1.5 py-0"
                          style={{
                            color:
                              r.status === "completed"
                                ? "#00CC66"
                                : r.status === "failed"
                                  ? "#FF3300"
                                  : r.status === "paused"
                                    ? "#FFCC00"
                                    : "#CCCCCC",
                            borderColor:
                              r.status === "completed"
                                ? "#00CC66"
                                : r.status === "failed"
                                  ? "#FF3300"
                                  : r.status === "paused"
                                    ? "#FFCC00"
                                    : "#CCCCCC",
                          }}
                        >
                          {r.status}
                        </span>
                        <span className="font-mono text-[11px] text-white tracking-widest">
                          {new Date(r.startedAt).toISOString().slice(0, 19)}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        {r.trigger} · {r.logs.length} logs
                      </span>
                    </button>
                    {expandedRun === r.id && (
                      <div className="mt-3 border border-[#666666]/20 bg-[#0D0D0D] p-3 font-mono text-[10px] leading-relaxed normal-case text-[#999999] max-h-80 overflow-y-auto">
                        {r.logs.length === 0 ? (
                          <div className="text-[#666666] tracking-widest uppercase">
                            AUCUN LOG
                          </div>
                        ) : (
                          r.logs.map((l, i) => (
                            <div
                              key={i}
                              className={
                                l.level === "error"
                                  ? "text-[#FF3300]"
                                  : l.level === "warn"
                                    ? "text-[#FFCC00]"
                                    : "text-[#CCCCCC]"
                              }
                            >
                              <span className="text-[#666666]">
                                [{new Date(l.at).toISOString().slice(11, 19)}
                                {l.nodeId ? `·${l.nodeId}` : ""}]
                              </span>{" "}
                              {l.message}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function formatConfig(n: NodesArray[number]): string {
  const cfg = n.config as Record<string, unknown>;
  if (!cfg || Object.keys(cfg).length === 0) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (v == null || (typeof v === "object" && Object.keys(v).length === 0))
      continue;
    const val =
      typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${val.length > 40 ? val.slice(0, 37) + "…" : val}`);
  }
  return parts.join(" · ");
}
