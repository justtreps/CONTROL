"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Keep the shape loose on the client — the server route is the
// single source of truth for data types.
type Stats = {
  generatedAt: string;
  globalStats: {
    testsRunning: number;
    completed7d: number;
    aborted7d: number;
    abortRate7d: number;
    monthCost: number;
    monthOrderCount: number;
    servicesScored: number;
    servicesEligible: number;
    avgCatalogueScore: number | null;
    toggles: {
      testBotEnabled: boolean;
      scoringEngineEnabled: boolean;
      dryRunMode: boolean;
    };
  };
  testsByHour: Array<{ hour: string; placed: number; real: number; dry: number }>;
  statusDistribution: Array<{ label: string; count: number; color: string }>;
  scoreDistribution: Array<{ label: string; count: number; color: string }>;
  rapidApiUsage: Array<{
    id: number;
    label: string;
    status: string;
    quotaUsed: number;
    quotaMonthly: number | null;
    ratio: number | null;
    lastUsedAt: string | null;
  }>;
  productBreakdown: Array<{
    slug: string;
    displayName: string;
    platform: string;
    productType: string;
    total: number;
    eligible: number;
    testedRecently7d: number;
    avgTop5: number | null;
  }>;
  topServices: Array<ServiceRow>;
  bottomServices: Array<ServiceRow>;
  recentEvents: Array<{
    at: string;
    kind: string;
    title: string;
    subtitle: string;
    color: string;
  }>;
  heatmap: number[][];
  campaign: {
    id: number;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    stopReason: string | null;
    targetCount: number;
    placedCount: number;
    placedPlacedCount: number;
    abortedCount: number;
    estimatedCostUsd: number | null;
    accumulatedCostUsd: number | null;
    etaMinutes: number | null;
    remaining: number;
  } | null;
};
type ServiceRow = {
  id: number;
  name: string;
  platform: string;
  score: number;
  lastTestedAt: string | null;
};

export function DashboardClient({
  initialStats,
}: {
  initialStats: Stats | Record<string, unknown> | null;
}) {
  const [stats, setStats] = useState<Stats | null>(
    (initialStats as Stats) ?? null
  );
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/stats", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const d = (await res.json()) as Stats;
      setStats(d);
    } catch {
      /* swallow */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!stats) {
    return (
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-24">
        <div className="max-w-7xl mx-auto font-mono text-xs text-[#666666] tracking-widest uppercase">
          CHARGEMENT…
        </div>
      </section>
    );
  }

  const g = stats.globalStats;

  return (
    <>
      {/* Header */}
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-8">
        <div className="max-w-7xl mx-auto flex flex-col gap-4">
          <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
            [ OBSERVABILITÉ LIVE · REFRESH 10s ]
          </div>
          <div className="flex items-end justify-between flex-wrap gap-4">
            <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
              Control<br />
              <span className="text-[#FF3300]">Dashboard.</span>
            </h1>
            <div className="flex flex-wrap gap-2">
              <ToggleChip label="TESTBOT" on={g.toggles.testBotEnabled} />
              <ToggleChip
                label="DRY RUN"
                on={g.toggles.dryRunMode}
                labels={["LIVE", "SIMULATION"]}
                invertColor
              />
              <ToggleChip
                label="SCORING"
                on={g.toggles.scoringEngineEnabled}
              />
              <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase self-center">
                {new Date(stats.generatedAt).toISOString().slice(11, 19)} UTC
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Global stats */}
      <section className="px-4 md:px-8 pb-10">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-0 border-y border-[#666666]/20">
          <StatCard
            label="TESTS RUNNING"
            value={g.testsRunning.toLocaleString("en-US")}
            color="#00CC66"
          />
          <StatCard
            label="COMPLÉTÉS · 7J"
            value={g.completed7d.toLocaleString("en-US")}
            color="#66CCFF"
          />
          <StatCard
            label="ABORTÉS · 7J"
            value={`${g.aborted7d.toLocaleString("en-US")}`}
            sub={`${g.abortRate7d.toFixed(1)}%`}
            color={g.abortRate7d > 20 ? "#FF3300" : "#FFCC00"}
          />
          <StatCard
            label="COÛT MOIS · USD"
            value={`$${g.monthCost.toFixed(2)}`}
            sub={`${g.monthOrderCount} orders`}
            color="#FF3300"
          />
          <StatCard
            label="SERVICES SCORÉS"
            value={`${g.servicesScored}`}
            sub={`/ ${g.servicesEligible}`}
            progress={
              g.servicesEligible > 0
                ? g.servicesScored / g.servicesEligible
                : 0
            }
            color="#FFCC00"
          />
          <StatCard
            label="SCORE MOY · CATALOGUE"
            value={
              g.avgCatalogueScore === null
                ? "—"
                : g.avgCatalogueScore.toFixed(1)
            }
            color={
              g.avgCatalogueScore !== null && g.avgCatalogueScore >= 60
                ? "#00CC66"
                : g.avgCatalogueScore !== null && g.avgCatalogueScore >= 40
                  ? "#FFCC00"
                  : "#FF3300"
            }
          />
        </div>
      </section>

      {/* Scoring campaign — inserted between stats and activity
          when active so it catches the eye. */}
      {stats.campaign && (
        <Section title="CAMPAGNE SCORING">
          <CampaignCard
            campaign={stats.campaign}
            onChanged={refresh}
          />
        </Section>
      )}

      {/* Activity — line + donut */}
      <Section title="ACTIVITÉ TEMPS RÉEL">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 border-y border-[#666666]/20">
          <div className="lg:col-span-2 p-5 md:p-6 border-b lg:border-b-0 lg:border-r border-[#666666]/20 bg-[#030303]">
            <ChartTitle label="TESTS PLACÉS / HEURE · 24H" />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={stats.testsByHour}
                  margin={{ top: 12, right: 12, bottom: 4, left: -16 }}
                >
                  <XAxis
                    dataKey="hour"
                    tick={{ fill: "#666666", fontSize: 10, fontFamily: "monospace" }}
                    axisLine={{ stroke: "#666666" }}
                    tickLine={false}
                    interval={2}
                  />
                  <YAxis
                    tick={{ fill: "#666666", fontSize: 10, fontFamily: "monospace" }}
                    axisLine={{ stroke: "#666666" }}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#030303",
                      border: "1px solid #FF3300",
                      fontFamily: "monospace",
                      fontSize: 11,
                    }}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="placed"
                    stroke="#FF3300"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="p-5 md:p-6 bg-[#0D0D0D]">
            <ChartTitle label="STATUTS · 30J" />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={stats.statusDistribution}
                    dataKey="count"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={85}
                    isAnimationActive={false}
                    stroke="#030303"
                    strokeWidth={2}
                  >
                    {stats.statusDistribution.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "#030303",
                      border: "1px solid #FF3300",
                      fontFamily: "monospace",
                      fontSize: 11,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col gap-1 mt-2">
              {stats.statusDistribution.map((d) => (
                <div
                  key={d.label}
                  className="flex items-center justify-between font-mono text-[10px] tracking-widest uppercase"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3"
                      style={{ background: d.color }}
                    />
                    <span className="text-[#CCCCCC]">{d.label}</span>
                  </span>
                  <span className="text-white tabular-nums">{d.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Score distribution */}
      <Section title="DISTRIBUTION DES SCORES">
        <div className="border-y border-[#666666]/20 p-5 md:p-6 bg-[#030303]">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={stats.scoreDistribution}
                layout="vertical"
                margin={{ top: 4, right: 12, bottom: 4, left: 12 }}
              >
                <XAxis
                  type="number"
                  tick={{ fill: "#666666", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#666666" }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#CCCCCC", fontSize: 11, fontFamily: "monospace" }}
                  axisLine={{ stroke: "#666666" }}
                  tickLine={false}
                  width={60}
                />
                <Tooltip
                  contentStyle={{
                    background: "#030303",
                    border: "1px solid #FF3300",
                    fontFamily: "monospace",
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="count" isAnimationActive={false}>
                  {stats.scoreDistribution.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Section>

      {/* RapidAPI usage */}
      <Section title="CONSOMMATION RAPIDAPI">
        <div className="border-y border-[#666666]/20 p-5 md:p-6 bg-[#0D0D0D] flex flex-col gap-3">
          <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case">
            Usage cumulé mensuel par clé. Les 24 h timeseries exigent
            une nouvelle table snapshot — déférée.
          </div>
          {stats.rapidApiUsage.length === 0 && (
            <div className="font-mono text-xs text-[#666666]">
              AUCUNE CLÉ ENREGISTRÉE
            </div>
          )}
          {stats.rapidApiUsage.map((k) => {
            const ratio = k.ratio ?? 0;
            const color =
              k.status === "capped"
                ? "#FF3300"
                : ratio >= 90
                  ? "#FF3300"
                  : ratio >= 70
                    ? "#FFCC00"
                    : "#00CC66";
            return (
              <div key={k.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between font-mono text-[11px] tracking-widest uppercase gap-3">
                  <span className="text-white truncate">
                    #{k.id} {k.label}{" "}
                    <span
                      className="text-[10px] normal-case"
                      style={{ color }}
                    >
                      [ {k.status.toUpperCase()} ]
                    </span>
                  </span>
                  <span className="text-white tabular-nums">
                    {k.quotaUsed.toLocaleString("en-US")}
                    {k.quotaMonthly ? (
                      <span className="text-[#666666]">
                        {" "}
                        / {k.quotaMonthly.toLocaleString("en-US")} ·{" "}
                        {ratio.toFixed(1)}%
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="w-full h-1 bg-[#666666]/20">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, ratio)}%`,
                      background: color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Product breakdown */}
      <Section title="BREAKDOWN PAR PRODUIT">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-0 border-y border-[#666666]/20">
          {stats.productBreakdown.map((p, idx) => {
            const bg = idx % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
            const avgColor =
              p.avgTop5 === null
                ? "#666666"
                : p.avgTop5 >= 60
                  ? "#00CC66"
                  : p.avgTop5 >= 40
                    ? "#FFCC00"
                    : "#FF3300";
            return (
              <div
                key={p.slug}
                className={`${bg} border border-[#666666]/20 p-4 flex flex-col gap-2`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
                    style={{
                      color: "#666666",
                      borderColor: "#666666",
                    }}
                  >
                    {p.platform === "instagram" ? "IG" : "TT"} ·{" "}
                    {p.productType.toUpperCase()}
                  </span>
                </div>
                <h3 className="brand font-display text-base tracking-tight text-white m-0 leading-tight">
                  {p.displayName}
                </h3>
                <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case leading-snug">
                  <div>
                    Candidats :{" "}
                    <span className="text-white">
                      {p.eligible}/{p.total}
                    </span>
                  </div>
                  <div>
                    Testés 7j :{" "}
                    <span className="text-white">{p.testedRecently7d}</span>
                  </div>
                  <div>
                    Score top 5 :{" "}
                    <span
                      className="font-mono tabular-nums"
                      style={{ color: avgColor }}
                    >
                      {p.avgTop5 === null ? "—" : p.avgTop5.toFixed(1)}
                    </span>
                  </div>
                </div>
                <Link
                  href={`/config/catalogue`}
                  className="interactive text-left font-mono text-[11px] tracking-widest uppercase border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 w-max mt-auto"
                >
                  [ VOIR → ]
                </Link>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Top / bottom services */}
      <Section title="TOP & FLOP SERVICES">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 border-y border-[#666666]/20">
          <ServicesTable
            title="TOP 10"
            rows={stats.topServices}
            accent="#00CC66"
            showDisable={false}
            onDisable={() => undefined}
          />
          <ServicesTable
            title="FLOP 10 · ACTIFS"
            rows={stats.bottomServices}
            accent="#FF3300"
            showDisable
            onDisable={async (id) => {
              if (!confirm("Désactiver ce service ? Il ne sera plus routé.")) return;
              const res = await fetch(`/api/config/services/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: false }),
              });
              if (res.ok) {
                await refresh();
                router.refresh();
              }
            }}
          />
        </div>
      </Section>

      {/* Timeline */}
      <Section title="TIMELINE LIVE">
        <div className="border-y border-[#666666]/20 bg-[#030303] max-h-[520px] overflow-y-auto">
          {stats.recentEvents.length === 0 && (
            <div className="px-6 py-8 font-mono text-xs text-[#666666] tracking-widest uppercase text-center">
              AUCUN ÉVÉNEMENT
            </div>
          )}
          {stats.recentEvents.map((e, i) => (
            <div
              key={i}
              className="px-5 py-3 border-b border-[#666666]/10 flex items-center gap-3 hover:bg-[#0D0D0D]"
            >
              <span
                className="font-mono text-[10px] tracking-widest uppercase px-2 py-0.5 border min-w-[90px] text-center"
                style={{ color: e.color, borderColor: e.color }}
              >
                {e.kind}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-white truncate">
                  {e.title}
                </div>
                <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case">
                  {e.subtitle}
                </div>
              </div>
              <span className="font-mono text-[10px] text-[#666666] tracking-widest whitespace-nowrap">
                {formatAge(e.at)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Heatmap */}
      <Section title="HEATMAP ACTIVITÉ · 7J × 24H">
        <div className="border-y border-[#666666]/20 p-5 md:p-6 bg-[#0D0D0D]">
          <HeatmapGrid data={stats.heatmap} />
        </div>
      </Section>

      {/* Footer: legacy link + actions */}
      <section className="px-4 md:px-8 py-10 border-t border-[#666666]/20">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3 items-center justify-between">
          <span className="font-mono text-[11px] text-[#666666] tracking-widest uppercase">
            Payload {new Date(stats.generatedAt).toISOString().slice(0, 19)} UTC
          </span>
          <div className="flex gap-3">
            <Link
              href="/alertes"
              className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
            >
              [ ALERTES → ]
            </Link>
            <Link
              href="/pool"
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
            >
              [ POOL → ]
            </Link>
            <Link
              href="/legacy"
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
            >
              [ ANCIEN DASHBOARD ]
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

// ── Primitives ─────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pb-10">
      <div className="max-w-7xl mx-auto px-4 md:px-8 pb-3">
        <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
          [ {title} ]
        </div>
      </div>
      <div className="max-w-7xl mx-auto px-4 md:px-8">{children}</div>
    </section>
  );
}

function ChartTitle({ label }: { label: string }) {
  return (
    <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase mb-2">
      {label}
    </div>
  );
}

function ToggleChip({
  label,
  on,
  labels,
  invertColor,
}: {
  label: string;
  on: boolean;
  labels?: [string, string]; // [onState, offState]
  invertColor?: boolean;
}) {
  const safeOn = invertColor ? on : on;
  const color = invertColor
    ? on
      ? "#00CC66"
      : "#FFCC00"
    : on
      ? "#00CC66"
      : "#666666";
  const text = labels ? (on ? labels[1] : labels[0]) : on ? "ON" : "OFF";
  return (
    <span
      className="font-mono text-[10px] tracking-widest uppercase border px-2 py-1"
      style={{ color, borderColor: color }}
    >
      {label}: {text}
      {!safeOn && invertColor ? " ⚠" : ""}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
  progress,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  progress?: number;
}) {
  return (
    <div className="p-5 border border-[#666666]/20 bg-[#030303] flex flex-col gap-1">
      <span
        className="font-mono text-[10px] tracking-widest uppercase"
        style={{ color }}
      >
        {label}
      </span>
      <span
        className="font-mono text-3xl tabular-nums"
        style={{ color }}
      >
        {value}
      </span>
      {sub && (
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          {sub}
        </span>
      )}
      {progress !== undefined && (
        <div className="w-full h-1 bg-[#666666]/20 mt-1">
          <div
            className="h-full transition-all"
            style={{
              width: `${Math.min(100, progress * 100)}%`,
              background: color,
            }}
          />
        </div>
      )}
    </div>
  );
}

function ServicesTable({
  title,
  rows,
  accent,
  showDisable,
  onDisable,
}: {
  title: string;
  rows: ServiceRow[];
  accent: string;
  showDisable: boolean;
  onDisable: (id: number) => void;
}) {
  return (
    <div className="bg-[#030303] p-5 md:p-6 flex flex-col gap-3">
      <div
        className="font-mono text-[10px] tracking-widest uppercase"
        style={{ color: accent }}
      >
        [ {title} ]
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-xs text-[#666666] tracking-widest uppercase">
          PAS ENCORE DE DONNÉE
        </div>
      ) : (
        <table className="w-full">
          <thead className="text-[#666666] font-mono text-[10px] uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-2 py-1 font-normal">#</th>
              <th className="text-left px-2 py-1 font-normal">Service</th>
              <th className="text-left px-2 py-1 font-normal">Plat.</th>
              <th className="text-right px-2 py-1 font-normal">Score</th>
              {showDisable && <th className="px-2 py-1" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.id}
                className="border-b border-[#666666]/10 hover:bg-[#0D0D0D]"
              >
                <td className="px-2 py-1.5 font-mono text-[11px] text-[#666666] tabular-nums">
                  {i + 1}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-white max-w-[280px] truncate">
                  {r.name}
                </td>
                <td className="px-2 py-1.5 font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                  {r.platform}
                </td>
                <td
                  className="px-2 py-1.5 font-mono text-[11px] tabular-nums text-right"
                  style={{ color: accent }}
                >
                  {r.score.toFixed(1)}
                </td>
                {showDisable && (
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => onDisable(r.id)}
                      className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase"
                    >
                      [ OFF ]
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HeatmapGrid({ data }: { data: number[][] }) {
  const max = Math.max(1, ...data.flat());
  const dayLabels = ["J-6", "J-5", "J-4", "J-3", "J-2", "J-1", "J0"];
  return (
    <div className="flex flex-col gap-1 overflow-x-auto">
      <div className="flex gap-0 pl-10">
        {Array.from({ length: 24 }).map((_, h) => (
          <div
            key={h}
            className="w-5 h-4 font-mono text-[9px] text-[#666666] text-center"
          >
            {h % 3 === 0 ? h : ""}
          </div>
        ))}
      </div>
      {data.map((row, d) => (
        <div key={d} className="flex items-center gap-0">
          <div className="w-10 font-mono text-[10px] text-[#666666] tracking-widest uppercase pr-2 text-right">
            {dayLabels[d]}
          </div>
          {row.map((v, h) => {
            const intensity = v === 0 ? 0 : Math.min(1, v / max);
            const bg =
              intensity === 0
                ? "#0D0D0D"
                : `rgba(255, 51, 0, ${0.15 + 0.85 * intensity})`;
            return (
              <div
                key={h}
                className="w-5 h-5 border border-[#030303]"
                style={{ background: bg }}
                title={`J-${6 - d} · ${h}h · ${v} tests`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CampaignCard({
  campaign,
  onChanged,
}: {
  campaign: NonNullable<Stats["campaign"]>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pct =
    campaign.targetCount > 0
      ? (campaign.placedCount / campaign.targetCount) * 100
      : 0;
  const color =
    campaign.status === "running"
      ? "#00CC66"
      : campaign.status === "paused"
        ? "#FFCC00"
        : campaign.status === "completed"
          ? "#66CCFF"
          : "#FF3300";

  async function call(path: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(path, { method: "POST" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-y border-[#666666]/20 p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
            style={{ color, borderColor: color }}
          >
            {campaign.status.replace("_", " ")}
          </span>
          <span className="brand font-display text-xl uppercase tracking-tight text-white">
            Campagne #{campaign.id}
          </span>
        </div>
        <div className="flex gap-2">
          {campaign.status === "running" && (
            <button
              type="button"
              onClick={() => call("/api/scoring/campaign/pause")}
              disabled={busy}
              className="interactive border border-[#FFCC00] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
            >
              [ PAUSER LA CAMPAGNE ]
            </button>
          )}
          {campaign.status === "paused" && (
            <button
              type="button"
              onClick={() => call("/api/scoring/campaign/resume")}
              disabled={busy}
              className="interactive border border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
            >
              [ REPRENDRE ]
            </button>
          )}
          {(campaign.status === "running" || campaign.status === "paused") && (
            <button
              type="button"
              onClick={() => {
                if (
                  confirm("Arrêter définitivement la campagne ? Les tests en vol finaliseront.")
                )
                  void call("/api/scoring/campaign/stop");
              }}
              disabled={busy}
              className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
            >
              [ ARRÊTER ]
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-0 border border-[#666666]/20">
        <div className="p-4 border-r border-b md:border-b-0 border-[#666666]/20">
          <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            SERVICES TESTÉS
          </div>
          <div className="font-mono text-2xl text-white tabular-nums mt-1">
            {campaign.placedCount}
            <span className="text-[#666666] text-sm"> / {campaign.targetCount}</span>
          </div>
        </div>
        <div className="p-4 border-b md:border-r md:border-b-0 border-[#666666]/20">
          <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            ETA
          </div>
          <div className="font-mono text-2xl text-white tabular-nums mt-1">
            {campaign.etaMinutes === null
              ? "—"
              : campaign.etaMinutes < 60
                ? `${campaign.etaMinutes}min`
                : `${Math.floor(campaign.etaMinutes / 60)}h${String(campaign.etaMinutes % 60).padStart(2, "0")}`}
          </div>
        </div>
        <div className="p-4 border-r border-[#666666]/20">
          <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            COÛT ACCUMULÉ
          </div>
          <div className="font-mono text-2xl text-[#FF3300] tabular-nums mt-1">
            {campaign.accumulatedCostUsd === null
              ? "—"
              : `$${campaign.accumulatedCostUsd.toFixed(2)}`}
          </div>
          {campaign.estimatedCostUsd !== null && (
            <div className="font-mono text-[10px] text-[#666666] mt-0.5">
              / ${campaign.estimatedCostUsd.toFixed(2)} estimé
            </div>
          )}
        </div>
        <div className="p-4">
          <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            ABORTÉS
          </div>
          <div
            className="font-mono text-2xl tabular-nums mt-1"
            style={{ color: campaign.abortedCount > 50 ? "#FF3300" : "#FFCC00" }}
          >
            {campaign.abortedCount}
          </div>
        </div>
      </div>

      <div className="w-full h-2 bg-[#666666]/20">
        <div
          className="h-full transition-all"
          style={{ width: `${Math.min(100, pct)}%`, background: color }}
        />
      </div>
      <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case">
        Démarrée {new Date(campaign.startedAt).toISOString().slice(0, 19)} UTC ·{" "}
        {pct.toFixed(1)}% complétée · {campaign.remaining} restants
        {campaign.stopReason && (
          <span className="text-[#FF3300]">
            {" "}
            · stop: {campaign.stopReason}
          </span>
        )}
      </div>
    </div>
  );
}

function formatAge(iso: string): string {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `il y a ${s}s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)}min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)}h`;
  return `il y a ${Math.floor(s / 86400)}j`;
}
