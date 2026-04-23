"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";

type ScrapeJobStats = {
  phase: "a" | "b";
  addedA: number;
  addedB: number;
  callsUsed: number;
  target: number;
  platform: "instagram" | "tiktok" | "both";
  errors: string[];
  poolType?: "follower" | "engagement";
};

type HealthJobStats = {
  platform: "instagram" | "tiktok" | "both";
  checked: number;
  invalidated: number;
  batchSize: number;
  callsUsed: number;
  errors: string[];
  poolType?: "follower" | "engagement";
};

type ExtractJobStats = {
  platform: "instagram" | "tiktok" | "both";
  target: number;
  addedPosts: number;
  accountsProcessed: number;
  accountsExhausted: number;
  callsUsed: number;
  oracleBackfills: number;
  errors: string[];
  poolType?: "follower" | "engagement";
};

type FillJobStats = {
  platform: "instagram" | "tiktok" | "both";
  target: number;
  phase: "extract" | "scrape" | "done";
  totalAdded: number;
  addedViaExtract: number;
  addedViaScrape: number;
  extract?: { accountsProcessed?: number; callsUsed?: number };
  scrape?: { callsUsed?: number };
  poolType?: "engagement";
};

type Job = {
  id: number;
  jobType:
    | "scrape"
    | "health_check"
    | "cleanup"
    | "engagement_extract"
    | "engagement_fill";
  platform: string | null;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats:
    | ScrapeJobStats
    | HealthJobStats
    | ExtractJobStats
    | FillJobStats
    | null;
  stopRequested: boolean;
  error: string | null;
};

// Section 4 — only renders when at least one job is active OR stuck.
// Polls /api/pool/jobs?status=running + status=pending + status=stuck
// every 5s. Stuck rows render a RED [ STUCK ] badge with a reason +
// [ RELANCER ] action so the operator can recover without digging.
export function PoolActiveJobs() {
  const router = useRouter();
  const toast = usePoolToast();
  const [rows, setRows] = useState<Job[]>([]);
  const [stopping, setStopping] = useState<Record<number, boolean>>({});
  const [relaunching, setRelaunching] = useState<Record<number, boolean>>({});

  const fetchActive = useCallback(async () => {
    try {
      const [running, pending, stuck] = await Promise.all([
        fetch("/api/pool/jobs?status=running&limit=10", { cache: "no-store" }),
        fetch("/api/pool/jobs?status=pending&limit=10", { cache: "no-store" }),
        fetch("/api/pool/jobs?status=stuck&limit=10", { cache: "no-store" }),
      ]);
      if (!running.ok || !pending.ok || !stuck.ok) return;
      const r = (await running.json()) as { rows: Job[] };
      const p = (await pending.json()) as { rows: Job[] };
      const s = (await stuck.json()) as { rows: Job[] };
      const merged = [...p.rows, ...r.rows, ...s.rows].sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      );
      setRows(merged);
    } catch {
      /* swallow */
    }
  }, []);

  async function relaunch(jobId: number) {
    if (relaunching[jobId]) return;
    setRelaunching((s) => ({ ...s, [jobId]: true }));
    try {
      const res = await fetch(`/api/pool/jobs/${jobId}/relaunch`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.push("ok", `JOB #${jobId} RELANCÉ → #${data.newJobId}`);
        router.refresh();
        fetchActive();
      } else {
        toast.push("err", data.error ?? `RELANCE #${jobId} ÉCHEC`);
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setRelaunching((s) => ({ ...s, [jobId]: false }));
    }
  }

  useEffect(() => {
    fetchActive();
    const id = setInterval(fetchActive, 5_000);
    return () => clearInterval(id);
  }, [fetchActive]);

  async function stop(jobId: number) {
    if (stopping[jobId]) return;
    setStopping((s) => ({ ...s, [jobId]: true }));
    try {
      const res = await fetch(`/api/pool/jobs/${jobId}/stop`, { method: "POST" });
      if (res.ok) {
        toast.push("ok", `JOB #${jobId} STOP REQUESTED`);
        setRows((rs) =>
          rs.map((x) => (x.id === jobId ? { ...x, stopRequested: true } : x))
        );
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.push("err", data.error ?? `STOP #${jobId} ÉCHEC`);
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setStopping((s) => ({ ...s, [jobId]: false }));
    }
  }

  if (rows.length === 0) return null;

  return (
    <section className="px-4 md:px-8 py-12 md:py-16">
      <div className="max-w-7xl mx-auto relative border border-[#666666]/30 p-5 md:p-8 pb-20 md:pb-24">
        <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none z-10">
          <span className="font-mono text-xs text-[#FF3300] tracking-widest">
            [ ACTIVE JOBS | {String(rows.length).padStart(2, "0")} RUNNING ]
          </span>
          <span className="font-mono text-xs text-white tracking-widest">
            ORCHESTRATOR_NODE
          </span>
        </div>

        <div className="flex flex-col gap-0">
          {rows.map((job, idx) => (
            <JobRow
              key={job.id}
              job={job}
              stopping={Boolean(stopping[job.id])}
              relaunching={Boolean(relaunching[job.id])}
              onStop={() => stop(job.id)}
              onRelaunch={() => relaunch(job.id)}
              divider={idx > 0}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function JobRow({
  job,
  stopping,
  relaunching,
  onStop,
  onRelaunch,
  divider,
}: {
  job: Job;
  stopping: boolean;
  relaunching: boolean;
  onStop: () => void;
  onRelaunch: () => void;
  divider: boolean;
}) {
  const poolType = (job.stats as { poolType?: "follower" | "engagement" } | null)
    ?.poolType;
  const poolSuffix = poolType
    ? ` · ${poolType === "follower" ? "ABONNÉS" : "ENGAGEMENT"}`
    : "";
  const label =
    `${job.jobType.toUpperCase()}${
      job.platform ? `_${job.platform.toUpperCase()}` : ""
    }${poolSuffix}`;
  const elapsed = Math.max(
    0,
    Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 60_000)
  );
  const elapsedLabel = elapsed < 1 ? "JUST NOW" : `${elapsed} MIN AGO`;

  let progress = "—";
  let calls = "—";
  if (job.stats) {
    if (job.jobType === "scrape") {
      const s = job.stats as ScrapeJobStats;
      progress = `${(s.addedA + s.addedB).toLocaleString("en-US")} / ${s.target.toLocaleString("en-US")} ACCOUNTS`;
      calls = s.callsUsed.toLocaleString("en-US");
    } else if (job.jobType === "health_check") {
      const s = job.stats as HealthJobStats;
      progress = `${s.checked} CHECKED · ${s.invalidated} INVALID`;
      calls = s.callsUsed.toLocaleString("en-US");
    } else if (job.jobType === "engagement_extract") {
      const s = job.stats as ExtractJobStats;
      progress = `${s.addedPosts.toLocaleString("en-US")} / ${s.target.toLocaleString("en-US")} POSTS · ${s.accountsProcessed} COMPTES · ${s.accountsExhausted} ÉPUISÉS`;
      calls = s.callsUsed.toLocaleString("en-US");
    } else if (job.jobType === "engagement_fill") {
      const s = job.stats as FillJobStats;
      const phaseLabel =
        s.phase === "extract"
          ? "PHASE 1 · EXTRACT"
          : s.phase === "scrape"
            ? "PHASE 2 · SEEDS"
            : "TERMINÉ";
      progress = `${s.totalAdded.toLocaleString("en-US")} / ${s.target.toLocaleString("en-US")} POSTS · ${phaseLabel} · EX:${s.addedViaExtract} SC:${s.addedViaScrape}`;
      const extractCalls = s.extract?.callsUsed ?? 0;
      const scrapeCalls = s.scrape?.callsUsed ?? 0;
      calls = (extractCalls + scrapeCalls).toLocaleString("en-US");
    }
  }

  const isStuck = job.status === "stuck";
  const statusLabel = job.stopRequested
    ? "[ STOPPING... ]"
    : isStuck
      ? "[ STUCK ]"
      : job.status === "pending"
        ? "[ PENDING ]"
        : "[ RUNNING ]";
  const statusColor = job.stopRequested
    ? "text-white"
    : isStuck
      ? "text-[#FF3300]"
      : job.status === "pending"
        ? "text-[#FFCC00]"
        : "text-[#FF3300]";

  // Human-readable French reason for a stuck job, surfaced in the
  // row directly under the label so the operator never has to open
  // the detail drawer to see what went wrong.
  const stuckReasonFr = isStuck
    ? job.error === "budget_exhausted"
      ? "BUDGET API ATTEINT"
      : job.error === "rate_limited_by_rapidapi"
        ? "LIMITE RAPIDAPI PAR SECONDE ATTEINTE"
        : job.error === "stale_no_progress"
          ? "AUCUNE PROGRESSION DEPUIS 30 MIN"
          : `STUCK · ${(job.error ?? "?").toString().toUpperCase()}`
    : null;

  return (
    <div
      className={`py-5 font-mono text-xs tracking-widest uppercase ${
        divider ? "border-t border-[#666666]/20" : ""
      } ${isStuck ? "bg-[#FF3300]/5" : ""}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-1">
        <div className="flex items-baseline gap-3">
          <span className="text-[#666666]">[ JOB_ID: {String(job.id).padStart(3, "0")} ]</span>
          <span className="brand font-display text-base text-white">{label}</span>
        </div>
        <span
          className={`${statusColor} ${
            isStuck ? "border border-[#FF3300] px-2 py-0.5" : ""
          }`}
        >
          {statusLabel}
        </span>
      </div>
      {stuckReasonFr && (
        <div className="mb-3 text-[11px] text-[#FF3300]/90 tracking-wide normal-case">
          → {stuckReasonFr}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-6 text-[#666666]">
        <Kv k="STARTED" v={elapsedLabel} />
        <Kv k="TRIGGER" v={job.trigger.toUpperCase()} />
        <Kv k="PROGRESS" v={progress} span2 />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-6 text-[#666666] mt-2">
        <Kv k="CALLS" v={calls} />
        <div className="md:col-span-3 flex items-center justify-end gap-3">
          {isStuck && (
            <button
              type="button"
              onClick={onRelaunch}
              disabled={relaunching}
              className="interactive border border-white bg-white text-black hover:bg-[#FF3300] hover:border-[#FF3300] transition-colors px-3 py-1 disabled:opacity-50"
            >
              {relaunching ? "[ RELANCE... ]" : "[ RELANCER ]"}
            </button>
          )}
          <button
            type="button"
            onClick={onStop}
            disabled={stopping || job.stopRequested || isStuck}
            className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 disabled:opacity-50"
          >
            [ STOP ]
          </button>
        </div>
      </div>
    </div>
  );
}

function Kv({ k, v, span2 = false }: { k: string; v: string; span2?: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 ${span2 ? "md:col-span-2" : ""}`}>
      <span className="text-[#666666]">{k}:</span>
      <span className="text-white truncate">{v}</span>
    </div>
  );
}
