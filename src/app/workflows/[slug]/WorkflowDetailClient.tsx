"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { NodesArray } from "@/lib/workflows/nodes";
import { WorkflowEditor } from "./WorkflowEditor";

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
    durationMs?: number;
  }>;
};

export function WorkflowDetailClient({
  slug,
  category,
  displayName,
  isActive,
  nodes,
  initialRuns,
}: {
  slug: string;
  category: string;
  displayName: string;
  isActive: boolean;
  nodes: NodesArray;
  initialRuns: Run[];
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(false);
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
      await fetch(
        `/api/workflows/${slug}/run${dryRun ? "?dryRun=1" : ""}`,
        { method: "POST" }
      );
      await refreshRuns();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${slug}/duplicate`, {
        method: "POST",
      });
      if (res.ok) {
        const d = (await res.json()) as { workflow: { slug: string } };
        router.push(`/workflows/${d.workflow.slug}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Action bar */}
      <section className="px-4 md:px-8 pb-4">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3 items-center">
          <button
            type="button"
            onClick={runNow}
            disabled={busy || !isActive}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
          >
            {busy ? "[ LANCEMENT… ]" : "[ LANCER MAINTENANT ]"}
          </button>
          <label className="interactive flex items-center gap-2 font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="accent-[#FF3300]"
            />
            [ DRY RUN (LOGS ONLY) ]
          </label>
          <button
            type="button"
            onClick={duplicate}
            disabled={busy}
            className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
          >
            [ DUPLIQUER ]
          </button>
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(true);
              void refreshRuns();
            }}
            className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase"
          >
            [ HISTORIQUE RUNS · {runs.length} ]
          </button>
        </div>
      </section>

      {/* Visual editor */}
      <section className="px-4 md:px-8 pb-16">
        <div className="max-w-7xl mx-auto border border-[#666666]/30 bg-[#030303] overflow-hidden">
          <WorkflowEditor
            slug={slug}
            initialNodes={nodes}
            readOnly={category !== "custom" ? false : false}
          />
        </div>
        <p className="max-w-7xl mx-auto pt-3 font-mono text-[10px] text-[#666666] normal-case leading-snug">
          Click un node → drawer de config. Drag pour déplacer, Delete pour
          supprimer. Drag d&apos;un handle bas vers le handle haut d&apos;un
          autre node → connexion. La validation DAG tourne au save (refuse les
          cycles + nodes orphelins).{" "}
          <Link
            href={`/workflows/${slug}`}
            className="interactive text-[#FF3300] hover:underline"
          >
            ↻ recharger
          </Link>
        </p>
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
          <div className="relative w-full sm:w-[760px] max-w-full bg-[#030303] border-l-2 border-[#FF3300] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
              <div className="min-w-0">
                <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
                  [ RUNS · {displayName} ]
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
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[10px] tracking-widest uppercase text-[#666666]">
                          #{r.id}
                        </span>
                        <RunStatusBadge status={r.status} />
                        <span className="font-mono text-[11px] text-white tracking-widest">
                          {new Date(r.startedAt).toISOString().slice(0, 19)}
                        </span>
                        <span className="font-mono text-[10px] text-[#666666] tracking-widest">
                          {formatDuration(r.startedAt, r.finishedAt)}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        {r.trigger} · {r.logs.length} étapes
                      </span>
                    </button>
                    {expandedRun === r.id && (
                      <RunTimeline logs={r.logs} />
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

function RunStatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "#00CC66"
      : status === "failed"
        ? "#FF3300"
        : status === "paused"
          ? "#FFCC00"
          : "#CCCCCC";
  return (
    <span
      className="font-mono text-[10px] tracking-widest uppercase border px-1.5 py-0"
      style={{ color, borderColor: color }}
    >
      {status}
    </span>
  );
}

function RunTimeline({
  logs,
}: {
  logs: Array<{
    at: string;
    nodeId: string | null;
    level: string;
    message: string;
    durationMs?: number;
  }>;
}) {
  return (
    <div className="mt-3 border border-[#666666]/20 bg-[#0D0D0D] p-3 font-mono text-[10px] leading-relaxed normal-case max-h-96 overflow-y-auto flex flex-col gap-0.5">
      {logs.length === 0 ? (
        <div className="text-[#666666] tracking-widest uppercase">
          AUCUN LOG
        </div>
      ) : (
        logs.map((l, i) => (
          <div
            key={i}
            className={
              "flex items-baseline gap-2 " +
              (l.level === "error"
                ? "text-[#FF3300]"
                : l.level === "warn"
                  ? "text-[#FFCC00]"
                  : "text-[#CCCCCC]")
            }
          >
            <span className="text-[#666666] font-mono text-[10px]">
              {new Date(l.at).toISOString().slice(11, 19)}
            </span>
            {l.nodeId && (
              <span
                className="text-[10px] tracking-widest uppercase border border-[#666666]/40 px-1"
                style={{ color: "#FF3300", borderColor: "#FF3300" }}
              >
                {l.nodeId}
              </span>
            )}
            <span className="flex-1">{l.message}</span>
            {typeof l.durationMs === "number" && (
              <span className="text-[#666666]">{l.durationMs}ms</span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "en cours";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}
