"use client";

import { useEffect, useState } from "react";
import type { PoolStats } from "@/lib/pool/stats";

type Props = { initialStats: PoolStats };

// Hero Pattern B with live stats block on the right. Polls
// /api/pool/stats every 10s; when at least one job is active the
// UI feels alive without slamming the DB.
export function PoolStatsHero({ initialStats }: Props) {
  const [stats, setStats] = useState<PoolStats>(initialStats);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/pool/stats", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { stats: PoolStats };
        if (!cancelled) setStats(data.stats);
      } catch {
        /* ignore transient failures */
      }
    };
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="px-4 md:px-8 pt-24 md:pt-32 pb-12 md:pb-16">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-12 items-end">
        <div className="lg:col-span-7 min-w-0 flex flex-col">
          <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max max-w-full truncate">
            [ POOL NODE | TEST ACCOUNT ORCHESTRATOR ]
          </div>
          <h1
            className="brand font-display uppercase tracking-tight leading-[0.85] text-white m-0 break-words"
            style={{ fontSize: "clamp(3rem, 7.5vw, 6.5rem)" }}
          >
            Account<br />
            <span className="text-[#FF3300]">Pool.</span>
          </h1>
        </div>

        <div className="lg:col-span-5 min-w-0 font-mono text-xs uppercase tracking-widest flex flex-col gap-6">
          <PlatformBlock label="INSTAGRAM" data={stats.instagram} />
          <PlatformBlock label="TIKTOK" data={stats.tiktok} />

          <div className="flex flex-col gap-2 pt-4 border-t border-[#666666]/20">
            <MetaRow
              label="AUTO-REFILL"
              value={stats.autoRefillEnabled ? "[ ENABLED ]" : "[ DISABLED ]"}
              accent={stats.autoRefillEnabled}
            />
            <MetaRow
              label="LAST SCRAPE"
              value={formatRelative(stats.lastScrapeAt)}
            />
            <MetaRow
              label="ACTIVE JOBS"
              value={String(stats.activeJobs).padStart(2, "0")}
              accent={stats.activeJobs > 0}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function PlatformBlock({
  label,
  data,
}: {
  label: string;
  data: { available: number; assigned: number; consumed: number; invalid: number; archived: number; target: number };
}) {
  const pct = Math.min(100, Math.round((data.available / Math.max(1, data.target)) * 100));
  return (
    <div className="flex flex-col gap-1 border-l-2 border-[#FF3300] pl-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[#FF3300]">{label}</span>
        <span className="text-[#666666] tabular-nums">{pct}%</span>
      </div>
      <Row
        label="AVAILABLE"
        value={`${data.available.toLocaleString("en-US")} / ${data.target.toLocaleString("en-US")}`}
        accent
      />
      <Row label="ASSIGNED" value={String(data.assigned)} />
      <Row label="CONSUMED" value={String(data.consumed)} />
      <Row label="INVALID" value={String(data.invalid)} />
    </div>
  );
}

function Row({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#666666]">{label}</span>
      <span className={`${accent ? "text-white" : "text-[#666666]"} tabular-nums`}>
        {value}
      </span>
    </div>
  );
}

function MetaRow({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#666666]">{label}</span>
      <span className={accent ? "text-[#FF3300]" : "text-white"}>{value}</span>
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "JUST NOW";
  if (min < 60) return `${min}M AGO`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}H AGO`;
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}
