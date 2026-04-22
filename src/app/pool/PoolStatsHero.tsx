"use client";

import { useEffect, useState } from "react";
import type { PoolStats } from "@/lib/pool/stats";

type Props = {
  initialStats: PoolStats;
  activePool: "follower" | "engagement";
};

// Hero Pattern B with live stats block on the right. Polls
// /api/pool/stats every 10s; when at least one job is active the
// UI feels alive without slamming the DB.
//
// The right-hand stats block is scoped to `activePool` — when the
// user is on POOL?type=engagement we only surface engagement counts
// + country breakdown to avoid cognitive mixing.
export function PoolStatsHero({ initialStats, activePool }: Props) {
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

  const poolLabel = activePool === "follower" ? "POOL ABONNÉS" : "POOL ENGAGEMENT";

  return (
    <section className="px-4 md:px-8 pt-12 md:pt-16 pb-12 md:pb-16">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-12 items-end">
        <div className="lg:col-span-7 min-w-0 flex flex-col">
          <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max max-w-full truncate">
            [ NŒUD {poolLabel} | ORCHESTRATEUR ]
          </div>
          <h1
            className="brand font-display uppercase tracking-tight leading-[0.85] text-white m-0 break-words"
            style={{ fontSize: "clamp(3rem, 7.5vw, 6.5rem)" }}
          >
            Pool<br />
            <span className="text-[#FF3300]">
              {activePool === "follower" ? "Abonnés." : "Engagement."}
            </span>
          </h1>
        </div>

        <div className="lg:col-span-5 min-w-0 font-mono text-xs uppercase tracking-widest flex flex-col gap-6">
          {/* Only the active pool's counts. The switch at the top of
              /pool is the structural source of truth for which pool
              we're looking at; mixing numbers here would muddy it. */}
          <ScopedPoolBlock stats={stats} activePool={activePool} />

          <CountryBreakdown stats={stats} activePool={activePool} />

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

// Emoji map for the top-countries row. Kept in sync with the one in
// PoolAccountsList. Unknown codes just show the bare ISO.
const FLAGS: Record<string, string> = {
  FR: "🇫🇷", BR: "🇧🇷", US: "🇺🇸", GB: "🇬🇧", DE: "🇩🇪",
  ES: "🇪🇸", IT: "🇮🇹", IN: "🇮🇳", MX: "🇲🇽", TR: "🇹🇷",
  SA: "🇸🇦", AE: "🇦🇪", JP: "🇯🇵", KR: "🇰🇷", CN: "🇨🇳",
  RU: "🇷🇺", ID: "🇮🇩", NG: "🇳🇬", AR: "🇦🇷", CO: "🇨🇴",
  CL: "🇨🇱", PE: "🇵🇪", PT: "🇵🇹", NL: "🇳🇱", BE: "🇧🇪",
  PL: "🇵🇱", CA: "🇨🇦", AU: "🇦🇺", PH: "🇵🇭", TH: "🇹🇭",
  VN: "🇻🇳", EG: "🇪🇬", ZA: "🇿🇦", IR: "🇮🇷", PK: "🇵🇰",
  BD: "🇧🇩", MA: "🇲🇦", DZ: "🇩🇿", TN: "🇹🇳",
};

function ScopedPoolBlock({
  stats,
  activePool,
}: {
  stats: PoolStats;
  activePool: "follower" | "engagement";
}) {
  const p =
    activePool === "follower" ? stats.followerPool : stats.engagementPool;
  const igCount = p.instagram.available + p.instagram.assigned;
  const ttCount = p.tiktok.available + p.tiktok.assigned;
  const title = activePool === "follower" ? "POOL ABONNÉS" : "POOL ENGAGEMENT";
  return (
    <PoolSummary
      title={title}
      igCount={igCount}
      ttCount={ttCount}
      accent
    />
  );
}

function PoolSummary({
  title,
  igCount,
  ttCount,
  accent = false,
}: {
  title: string;
  igCount: number;
  ttCount: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 border-l-2 pl-3 ${accent ? "border-[#FF3300]" : "border-[#666666]/60"}`}
    >
      <div className={`${accent ? "text-[#FF3300]" : "text-white"}`}>{title}</div>
      <Row label="IG" value={igCount.toLocaleString("en-US")} accent />
      <Row label="TT" value={ttCount.toLocaleString("en-US")} accent />
    </div>
  );
}

function CountryBreakdown({
  stats,
  activePool,
}: {
  stats: PoolStats;
  activePool: "follower" | "engagement";
}) {
  const rows =
    activePool === "follower"
      ? stats.countryBreakdown.follower
      : stats.countryBreakdown.engagement;
  if (rows.length === 0) return null;
  const label = activePool === "follower" ? "POOL ABONNÉS" : "POOL ENGAGEMENT";
  return (
    <div className="flex flex-col gap-1 pt-4 border-t border-[#666666]/20">
      <div className="text-[#666666]">[ TOP PAYS · {label} ]</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {rows.slice(0, 5).map((c) => (
          <span key={c.country ?? "null"} className="text-white">
            {c.country
              ? `${FLAGS[c.country] ?? ""} ${c.country}`
              : "UNKNOWN"}{" "}
            <span className="text-[#666666]">{c.count}</span>
          </span>
        ))}
      </div>
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
