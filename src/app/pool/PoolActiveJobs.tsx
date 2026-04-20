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
};

type HealthJobStats = {
  platform: "instagram" | "tiktok" | "both";
  checked: number;
  invalidated: number;
  batchSize: number;
  callsUsed: number;
  errors: string[];
};

type Job = {
  id: number;
  jobType: "scrape" | "health_check" | "cleanup";
  platform: string | null;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats: ScrapeJobStats | HealthJobStats | null;
  stopRequested: boolean;
  error: string | null;
};

// Section 4 — only renders when at least one job is active. Polls
// /api/pool/jobs?status=running every 5s; also picks up 'pending'
// jobs that haven't been touched by the orchestrator yet.
export function PoolActiveJobs() {
  const router = useRouter();
  const toast = usePoolToast();
  const [rows, setRows] = useState<Job[]>([]);
  const [stopping, setStopping] = useState<Record<number, boolean>>({});

  const fetchActive = useCallback(async () => {
    try {
      const [running, pending] = await Promise.all([
        fetch("/api/pool/jobs?status=running&limit=10", { cache: "no-store" }),
        fetch("/api/pool/jobs?status=pending&limit=10", { cache: "no-store" }),
      ]);
      if (!running.ok || !pending.ok) return;
      const r = (await running.json()) as { rows: Job[] };
      const p = (await pending.json()) as { rows: Job[] };
      const merged = [...p.rows, ...r.rows].sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      );
      setRows(merged);
    } catch {
      /* swallow */
    }
  }, []);

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
              onStop={() => stop(job.id)}
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
  onStop,
  divider,
}: {
  job: Job;
  stopping: boolean;
  onStop: () => void;
  divider: boolean;
}) {
  const label =
    `${job.jobType.toUpperCase()}${
      job.platform ? `_${job.platform.toUpperCase()}` : ""
    }`;
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
    }
  }

  const statusLabel = job.stopRequested
    ? "[ STOPPING... ]"
    : job.status === "pending"
      ? "[ PENDING ]"
      : "[ RUNNING ]";
  const statusColor = job.stopRequested
    ? "text-white"
    : job.status === "pending"
      ? "text-[#FFCC00]"
      : "text-[#FF3300]";

  return (
    <div
      className={`py-5 font-mono text-xs tracking-widest uppercase ${
        divider ? "border-t border-[#666666]/20" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[#666666]">[ JOB_ID: {String(job.id).padStart(3, "0")} ]</span>
          <span className="brand font-display text-base text-white">{label}</span>
        </div>
        <span className={statusColor}>{statusLabel}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-6 text-[#666666]">
        <Kv k="STARTED" v={elapsedLabel} />
        <Kv k="TRIGGER" v={job.trigger.toUpperCase()} />
        <Kv k="PROGRESS" v={progress} span2 />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-6 text-[#666666] mt-2">
        <Kv k="CALLS" v={calls} />
        <div className="md:col-span-3 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onStop}
            disabled={stopping || job.stopRequested}
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
