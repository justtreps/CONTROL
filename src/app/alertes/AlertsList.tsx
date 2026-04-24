"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Alert = {
  id: number;
  code: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  explanation: string;
  impact: string;
  suggestedAction: string;
  actionType: string | null;
  actionPayload: unknown;
  relatedEntityType: string | null;
  relatedEntityId: number | null;
  status: string;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  triggerCount: number;
};

type Counts = {
  crit: number;
  warn: number;
  info: number;
  ack: number;
  resolved: number;
};

type StatusFilter = "active_or_ack" | "active" | "acknowledged" | "resolved" | "all";
type SeverityFilter = "all" | "critical" | "warning" | "info";
type CategoryFilter =
  | "all"
  | "infra"
  | "pool"
  | "job"
  | "catalogue"
  | "business"
  | "rapidapi"
  | "testbot";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#FF3300",
  warning: "#FFCC00",
  info: "#66CCFF",
};

export function AlertsList({
  initial,
  counts,
}: {
  initial: Alert[];
  counts: Counts;
}) {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>(initial);
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>("active_or_ack");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selected, setSelected] = useState<Alert | null>(null);
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  const refresh = useCallback(async () => {
    const p = new URLSearchParams({
      status: statusFilter,
      severity: severityFilter,
      category: categoryFilter,
      limit: "200",
    });
    const res = await fetch(`/api/alerts?${p}`, { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { alerts: Alert[] };
    setAlerts(d.alerts);
  }, [statusFilter, severityFilter, categoryFilter]);

  useEffect(() => {
    refresh();
    // Poll live for freshness while the operator is on the page.
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function acknowledge(id: number) {
    if (busy[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fetch(`/api/alerts/${id}/acknowledge`, { method: "POST" });
      await refresh();
      router.refresh();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function resolve(id: number) {
    if (busy[id]) return;
    if (!confirm("Marquer cette alerte résolue ?")) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fetch(`/api/alerts/${id}/resolve`, { method: "POST" });
      await refresh();
      router.refresh();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  // When the user clicks a chip in the counter row, narrow the severity filter.
  function filterBySeverity(s: SeverityFilter) {
    setSeverityFilter(s);
    setStatusFilter("active");
  }

  return (
    <>
      {/* Severity counters */}
      <section className="px-4 md:px-8 pb-4">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-5 gap-0 border-y border-[#666666]/20">
          <CounterChip
            label="CRITIQUE"
            value={counts.crit}
            color="#FF3300"
            onClick={() => filterBySeverity("critical")}
            active={severityFilter === "critical"}
          />
          <CounterChip
            label="WARNING"
            value={counts.warn}
            color="#FFCC00"
            onClick={() => filterBySeverity("warning")}
            active={severityFilter === "warning"}
          />
          <CounterChip
            label="INFO"
            value={counts.info}
            color="#66CCFF"
            onClick={() => filterBySeverity("info")}
            active={severityFilter === "info"}
          />
          <CounterChip
            label="ACQUITTÉES"
            value={counts.ack}
            color="#CCCCCC"
            onClick={() => {
              setStatusFilter("acknowledged");
              setSeverityFilter("all");
            }}
            active={statusFilter === "acknowledged"}
          />
          <CounterChip
            label="RÉSOLUES"
            value={counts.resolved}
            color="#00CC66"
            onClick={() => {
              setStatusFilter("resolved");
              setSeverityFilter("all");
            }}
            active={statusFilter === "resolved"}
          />
        </div>
      </section>

      {/* Filter bar */}
      <section className="px-4 md:px-8 pb-4">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3 items-center">
          <FilterGroup
            label="STATUT"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={[
              ["active_or_ack", "ACTIVES + ACQUITTÉES"],
              ["active", "ACTIVES"],
              ["acknowledged", "ACQUITTÉES"],
              ["resolved", "RÉSOLUES"],
              ["all", "TOUTES"],
            ]}
          />
          <FilterGroup
            label="SÉVÉRITÉ"
            value={severityFilter}
            onChange={(v) => setSeverityFilter(v as SeverityFilter)}
            options={[
              ["all", "TOUTES"],
              ["critical", "CRITIQUE"],
              ["warning", "WARNING"],
              ["info", "INFO"],
            ]}
          />
          <FilterGroup
            label="CATÉGORIE"
            value={categoryFilter}
            onChange={(v) => setCategoryFilter(v as CategoryFilter)}
            options={[
              ["all", "TOUTES"],
              ["rapidapi", "RAPIDAPI"],
              ["pool", "POOL"],
              ["job", "JOB"],
              ["catalogue", "CATALOGUE"],
              ["business", "BUSINESS"],
              ["testbot", "TESTBOT"],
              ["infra", "INFRA"],
            ]}
          />
        </div>
      </section>

      {/* Alerts list */}
      <section className="px-4 md:px-8 pb-24">
        <div className="max-w-7xl mx-auto border border-[#666666]/30">
          {alerts.length === 0 ? (
            <div className="px-6 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
              ✓ AUCUNE ALERTE DANS CETTE VUE
            </div>
          ) : (
            alerts.map((a, idx) => (
              <AlertRow
                key={a.id}
                alert={a}
                onOpen={() => setSelected(a)}
                onAck={() => acknowledge(a.id)}
                onResolve={() => resolve(a.id)}
                busy={Boolean(busy[a.id])}
                bg={idx % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]"}
              />
            ))
          )}
        </div>
      </section>

      {/* Explain drawer */}
      {selected && (
        <AlertDrawer
          alert={selected}
          onClose={() => setSelected(null)}
          onAck={() => acknowledge(selected.id)}
          onResolve={() => resolve(selected.id)}
          busy={Boolean(busy[selected.id])}
        />
      )}
    </>
  );
}

function CounterChip({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "interactive p-5 flex flex-col gap-1 text-left border border-[#666666]/20 transition-colors " +
        (active ? "bg-[#0D0D0D]" : "hover:bg-[#0D0D0D]")
      }
      style={{
        borderLeft: active ? `3px solid ${color}` : undefined,
      }}
    >
      <span
        className="font-mono text-[10px] tracking-widest uppercase"
        style={{ color }}
      >
        {label}
      </span>
      <span
        className="font-mono text-3xl tabular-nums"
        style={{ color: value > 0 ? color : "#666666" }}
      >
        {value}
      </span>
    </button>
  );
}

function FilterGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}:
      </span>
      <select
        className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-2 py-1 font-mono text-[11px] tracking-widest uppercase text-white outline-none"
        value={value}
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

function AlertRow({
  alert: a,
  bg,
  busy,
  onOpen,
  onAck,
  onResolve,
}: {
  alert: Alert;
  bg: string;
  busy: boolean;
  onOpen: () => void;
  onAck: () => void;
  onResolve: () => void;
}) {
  const color = SEVERITY_COLORS[a.severity] ?? "#CCCCCC";
  const ageMin = Math.floor(
    (Date.now() - new Date(a.lastTriggeredAt).getTime()) / 60_000
  );
  const ageTxt =
    ageMin < 1
      ? "à l'instant"
      : ageMin < 60
        ? `il y a ${ageMin}min`
        : `il y a ${Math.floor(ageMin / 60)}h`;
  return (
    <div
      className={`${bg} border-b border-[#666666]/20 last:border-b-0 p-5 md:p-6 flex flex-col md:flex-row gap-4 md:items-center`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 items-center">
          <span
            className="font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
            style={{ color, borderColor: color }}
          >
            {a.severity}
          </span>
          <span className="font-mono text-[10px] tracking-widest uppercase border border-[#666666]/40 text-[#666666] px-2 py-0.5">
            {a.category}
          </span>
          {a.status === "acknowledged" && (
            <span className="font-mono text-[10px] tracking-widest uppercase border border-[#CCCCCC]/50 text-[#CCCCCC] px-2 py-0.5">
              ACQUITTÉE
            </span>
          )}
          {a.triggerCount > 1 && (
            <span className="font-mono text-[10px] tracking-widest uppercase text-[#666666]">
              × {a.triggerCount}
            </span>
          )}
        </div>
        <h3 className="brand font-display text-lg md:text-xl uppercase tracking-tight text-white leading-tight m-0">
          {a.title}
        </h3>
        <p className="font-mono text-xs text-[#CCCCCC] normal-case leading-relaxed max-w-3xl">
          {a.description}
        </p>
        <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          Détectée {ageTxt} · {a.code}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 md:flex-col md:items-end">
        <button
          type="button"
          onClick={onOpen}
          className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
        >
          [ EXPLIQUER ]
        </button>
        {a.status === "active" && (
          <button
            type="button"
            onClick={onAck}
            disabled={busy}
            className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
          >
            [ ACQUITTER ]
          </button>
        )}
        <button
          type="button"
          onClick={onResolve}
          disabled={busy}
          className="interactive border border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
        >
          [ RÉSOUDRE ]
        </button>
      </div>
    </div>
  );
}

function AlertDrawer({
  alert: a,
  busy,
  onClose,
  onAck,
  onResolve,
}: {
  alert: Alert;
  busy: boolean;
  onClose: () => void;
  onAck: () => void;
  onResolve: () => void;
}) {
  const color = SEVERITY_COLORS[a.severity] ?? "#CCCCCC";
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const runAction = useCallback(async () => {
    if (!a.actionType || !a.actionPayload) return;
    const p = a.actionPayload as {
      endpoint?: string;
      method?: string;
      body?: Record<string, unknown>;
      confirm?: string;
      href?: string;
    };
    if (a.actionType === "link" && p.href) {
      window.location.href = p.href;
      return;
    }
    if (a.actionType !== "button" || !p.endpoint) return;
    if (p.confirm && !confirm(p.confirm)) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const res = await fetch(p.endpoint, {
        method: p.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: p.body ? JSON.stringify(p.body) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setActionMsg("✓ ACTION LANCÉE");
      } else {
        setActionMsg(`✗ ÉCHEC: ${d.error ?? res.status}`);
      }
    } catch (e) {
      setActionMsg(`✗ ERREUR: ${(e as Error).message.slice(0, 80)}`);
    } finally {
      setActionBusy(false);
    }
  }, [a.actionType, a.actionPayload]);

  const actionLabel = useMemo(() => {
    if (!a.actionType) return null;
    // Short labels depending on code prefix.
    if (a.code.startsWith("pool_below_min")) return "[ LANCER UN SCRAPE MAINTENANT ]";
    if (a.code.startsWith("key_near_cap") || a.code.startsWith("all_keys_capped"))
      return "[ VOIR LES CLÉS ]";
    if (a.code.startsWith("key_capped")) return "[ VOIR LES CLÉS ]";
    if (a.code.startsWith("job_stuck")) return "[ RELANCER LE JOB ]";
    if (a.code.startsWith("scrape_stale") || a.code.startsWith("job_too_long"))
      return "[ VOIR LE JOB ]";
    if (a.code.startsWith("order_api_fail_rate")) return "[ VOIR LOGS ]";
    if (a.code.startsWith("candidates_zero") || a.code.startsWith("product_low_avg"))
      return "[ VOIR CATALOGUE ]";
    if (a.code.startsWith("scoring_stale")) return "[ VOIR POOL ]";
    // Fallback
    if (a.actionType === "button") return "[ ACTION ]";
    return "[ OUVRIR ]";
  }, [a.code, a.actionType]);

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Fermer"
        className="flex-1 bg-black/70 backdrop-blur-sm"
      />
      <div className="relative w-full sm:w-[720px] max-w-full bg-[#030303] border-l-2 overflow-y-auto flex flex-col"
        style={{ borderColor: color }}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex gap-2 items-center">
              <span
                className="font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
                style={{ color, borderColor: color }}
              >
                {a.severity}
              </span>
              <span className="font-mono text-[10px] tracking-widest uppercase border border-[#666666]/40 text-[#666666] px-2 py-0.5">
                {a.category}
              </span>
            </div>
            <h3 className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white leading-tight m-0 mt-1">
              {a.title}
            </h3>
            <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
              {a.code}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="interactive font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white px-3 py-1 border border-[#666666]/40 hover:border-white transition-colors"
          >
            [ ✕ ]
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-6">
          <Section label="DESCRIPTION" body={a.description} />
          <Section label="POURQUOI — EXPLICATION" body={a.explanation} />
          <Section label="IMPACT" body={a.impact} />
          <Section label="ACTION SUGGÉRÉE" body={a.suggestedAction} />

          {a.actionType && (
            <div className="flex flex-col gap-2">
              {a.actionType === "link" ? (
                <Link
                  href={
                    (a.actionPayload as { href?: string } | null)?.href ?? "#"
                  }
                  className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase w-max"
                >
                  {actionLabel}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={runAction}
                  disabled={actionBusy}
                  className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase w-max disabled:opacity-60"
                >
                  {actionBusy ? "[ ACTION… ]" : actionLabel}
                </button>
              )}
              {actionMsg && (
                <span className="font-mono text-[11px] tracking-widest uppercase">
                  {actionMsg}
                </span>
              )}
            </div>
          )}

          <div className="border-t border-[#666666]/20 pt-4 flex flex-col gap-1 font-mono text-[11px] text-[#666666] tracking-wide normal-case">
            <div>
              <span className="text-[#666666] uppercase tracking-widest text-[10px]">
                1ère détection :{" "}
              </span>
              <span className="text-white">
                {new Date(a.firstTriggeredAt).toISOString().slice(0, 19)} UTC
              </span>
            </div>
            <div>
              <span className="text-[#666666] uppercase tracking-widest text-[10px]">
                Dernière détection :{" "}
              </span>
              <span className="text-white">
                {new Date(a.lastTriggeredAt).toISOString().slice(0, 19)} UTC
              </span>
            </div>
            <div>
              <span className="text-[#666666] uppercase tracking-widest text-[10px]">
                Ré-déclenchée :{" "}
              </span>
              <span className="text-white">{a.triggerCount} fois</span>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            {a.status === "active" && (
              <button
                type="button"
                onClick={onAck}
                disabled={busy}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
              >
                [ ACQUITTER ]
              </button>
            )}
            <button
              type="button"
              onClick={onResolve}
              disabled={busy}
              className="interactive border border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
            >
              [ MARQUER RÉSOLUE ]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
        [ {label} ]
      </div>
      <p className="font-mono text-xs text-white normal-case leading-relaxed whitespace-pre-wrap">
        {body}
      </p>
    </div>
  );
}
