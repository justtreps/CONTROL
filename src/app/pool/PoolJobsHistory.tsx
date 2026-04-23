"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton, SkeletonRow } from "@/components/Skeleton";

// Sub-section D of Configuration avancée — past + present scrape /
// health-check / cleanup jobs, filtered and paginated, with a detail
// drawer that opens on row click and shows the full PoolJob.stats JSON.
//
// Read-only: no stop / retry / delete here. Active jobs already have
// their own card (PoolActiveJobs) up in Zone 2 with a [STOP] button —
// this is pure forensic history.
type JobRow = {
  id: number;
  jobType: "scrape" | "health_check" | "cleanup" | string;
  platform: string | null;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  stopRequested: boolean;
};

type ListResponse = {
  rows: JobRow[];
  total: number;
  limit: number;
  offset: number;
};

const STATUS_COLOR: Record<string, string> = {
  pending: "#FFCC00",
  running: "#FF3300",
  completed: "#FFFFFF",
  stopped: "#999999",
  error: "#FF3300",
};

const STATUS_LABEL_FR: Record<string, string> = {
  pending: "EN ATTENTE",
  running: "EN COURS",
  completed: "TERMINÉ",
  stopped: "ARRÊTÉ",
  error: "ERREUR",
};

const TYPE_LABEL_FR: Record<string, string> = {
  scrape: "SCRAPE",
  health_check: "VÉRIF.",
  cleanup: "NETTOYAGE",
  engagement_extract: "EXTRACT",
  engagement_fill: "FILL",
};

const FILTER_CLS =
  "interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";

export function PoolJobsHistory() {
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [limit, setLimit] = useState(10);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const offset = useMemo(() => (page - 1) * limit, [page, limit]);
  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total / limit)) : 1),
    [data, limit]
  );

  // silent=true skips the loading state (used by the 15s poller so
  // the table doesn't flash to skeletons every tick).
  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams();
        if (type !== "all") params.set("type", type);
        if (status !== "all") params.set("status", status);
        if (platform !== "all") params.set("platform", platform);
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        const res = await fetch(`/api/pool/jobs?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        setData((await res.json()) as ListResponse);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [type, status, platform, limit, offset]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => {
    setPage(1);
  }, [type, status, platform, limit]);

  // Background auto-refresh every 15s while mounted. Uses silent mode
  // so the existing rows stay visible; only the data gets swapped.
  // Pauses while the tab is in the background to avoid wasted queries.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshRef.current(true);
      }
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="w-full bg-[#030303]">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 px-4 md:px-8 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={FILTER_CLS}
          aria-label="Type de job"
        >
          <option value="all">TOUS TYPES</option>
          <option value="scrape">SCRAPE</option>
          <option value="health_check">VÉRIFICATION</option>
          <option value="cleanup">NETTOYAGE</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={FILTER_CLS}
          aria-label="Statut"
        >
          <option value="all">TOUS STATUTS</option>
          <option value="pending">EN ATTENTE</option>
          <option value="running">EN COURS</option>
          <option value="completed">TERMINÉ</option>
          <option value="stopped">ARRÊTÉ</option>
          <option value="error">ERREUR</option>
        </select>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className={FILTER_CLS}
          aria-label="Plateforme"
        >
          <option value="all">TOUTES PLATEFORMES</option>
          <option value="instagram">INSTAGRAM</option>
          <option value="tiktok">TIKTOK</option>
        </select>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-3 py-2 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-60 ml-auto"
          aria-label="Rafraîchir l'historique"
        >
          [ ↻ RAFRAÎCHIR ]
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-4 py-3 font-normal">Job</th>
              <th className="text-left px-3 py-3 font-normal">Type</th>
              <th className="text-left px-3 py-3 font-normal hidden md:table-cell">
                Plat.
              </th>
              <th className="text-left px-3 py-3 font-normal hidden lg:table-cell">
                Trigger
              </th>
              <th className="text-left px-3 py-3 font-normal">Statut</th>
              <th className="text-left px-3 py-3 font-normal hidden sm:table-cell">
                Lancé
              </th>
              <th className="text-right px-3 py-3 font-normal hidden md:table-cell">
                Durée
              </th>
              <th className="text-left px-3 py-3 font-normal hidden xl:table-cell">
                Résumé
              </th>
              <th className="text-right px-3 py-3 font-normal">—</th>
            </tr>
          </thead>
          <tbody aria-busy={loading} aria-live="polite">
            {loading && !data && (
              <>
                {Array.from({ length: Math.min(limit, 8) }).map((_, i) => (
                  <SkeletonRow key={`sk-${i}`} cols={9} compact />
                ))}
              </>
            )}
            {data?.rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setOpenId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenId(r.id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Ouvrir le détail du job ${String(r.id).padStart(4, "0")}`}
                className="interactive border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF3300] focus-visible:outline-offset-[-2px] transition-all duration-200 cursor-pointer"
              >
                <td className="px-4 py-3 font-mono text-xs text-white tabular-nums whitespace-nowrap">
                  #{String(r.id).padStart(4, "0")}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#FF3300] tracking-widest uppercase whitespace-nowrap">
                  {TYPE_LABEL_FR[r.jobType] ?? r.jobType.toUpperCase()}
                  <span className="text-[#666666]">{poolSuffix(r)}</span>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] tracking-widest uppercase hidden md:table-cell">
                  {r.platform ? shortPlatform(r.platform) : "—"}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] tracking-widest uppercase hidden lg:table-cell">
                  {triggerLabel(r.trigger)}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <span
                    className="font-mono text-xs tracking-widest uppercase"
                    style={{ color: STATUS_COLOR[r.status] ?? "#FFFFFF" }}
                  >
                    {STATUS_LABEL_FR[r.status] ?? r.status.toUpperCase()}
                  </span>
                  {r.stopRequested && r.status === "running" && (
                    <span className="ml-2 font-mono text-[10px] text-[#FFCC00]">
                      · STOP REQ
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden sm:table-cell">
                  {short(r.startedAt)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden md:table-cell">
                  {duration(r.startedAt, r.endedAt)}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] truncate max-w-xs hidden xl:table-cell">
                  {summary(r)}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <span className="interactive font-mono text-xs text-[#FF3300] hover:text-white transition-colors">
                    [&nbsp;DÉTAILS&nbsp;]
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && data?.rows.length === 0 && (
          <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
            AUCUN JOB NE CORRESPOND À CES FILTRES.
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-8 py-4 border-t border-[#666666]/20 font-mono text-xs tracking-widest uppercase">
          <div className="text-[#666666] tabular-nums flex items-center gap-4 flex-wrap">
            <span>
              [ PAGE {String(page).padStart(2, "0")} / {String(totalPages).padStart(2, "0")} ]
            </span>
            <span className="text-[#666666]/60">
              {data.total.toLocaleString("en-US")} JOBS AU TOTAL
            </span>
            <label className="flex items-center gap-2">
              <span className="text-[#666666]/60">PAR PAGE</span>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-2 py-1 font-mono text-xs tracking-widest uppercase text-white outline-none"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [&nbsp;←&nbsp;]
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [&nbsp;→&nbsp;]
            </button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {openId !== null && (
        <JobDetailModal id={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────
// Fixed right-side drawer, 600px wide on desktop, full-screen on
// mobile. Closes on backdrop click or Escape.
function JobDetailModal({
  id,
  onClose,
}: {
  id: number;
  onClose: () => void;
}) {
  const [job, setJob] = useState<JobRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevActiveRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/pool/jobs/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { row: JobRow };
        if (!cancelled) setJob(d.row);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Capture focus: remember what was focused, move focus to the close
  // button, restore on unmount. Keeps the modal operable for keyboard
  // + screen reader users and puts focus back where they were.
  useEffect(() => {
    prevActiveRef.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => {
      prevActiveRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="job-detail-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Fermer"
        className="flex-1 bg-black/70 backdrop-blur-sm"
      />
      {/* Panel */}
      <div className="relative w-full sm:w-[600px] max-w-full bg-[#030303] border-l-2 border-[#FF3300] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
          <div className="min-w-0">
            <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
              [ JOB #{String(id).padStart(4, "0")} ]
            </div>
            <h3
              id="job-detail-title"
              className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white m-0 leading-none mt-1"
            >
              {job
                ? `${TYPE_LABEL_FR[job.jobType] ?? job.jobType.toUpperCase()}${
                    job.platform ? ` · ${shortPlatform(job.platform)}` : ""
                  }${poolSuffix(job)}`
                : "…"}
            </h3>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="interactive border border-[#666666]/40 hover:border-white hover:text-white text-[#666666] px-3 py-2 font-mono text-xs tracking-widest uppercase transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF3300]"
            aria-label="Fermer le détail"
          >
            [&nbsp;FERMER&nbsp;]
          </button>
        </div>

        <div
          className="flex-1 px-5 py-5 flex flex-col gap-5 font-mono text-xs tracking-widest uppercase"
          aria-busy={loading}
        >
          {loading && (
            <div className="flex flex-col gap-5" aria-hidden="true">
              <Skeleton height={14} className="w-28" />
              <div className="flex flex-col gap-2">
                <Skeleton height={12} className="w-full" />
                <Skeleton height={12} className="w-5/6" />
                <Skeleton height={12} className="w-2/3" />
              </div>
              <Skeleton height={14} className="w-24" />
              <div className="flex flex-col gap-2">
                <Skeleton height={12} className="w-full" />
                <Skeleton height={12} className="w-3/4" />
              </div>
              <Skeleton height={14} className="w-32" />
              <Skeleton height={180} className="w-full" />
            </div>
          )}
          {error && (
            <div className="text-[#FF3300] py-10 text-center" role="alert">
              ERREUR DE CHARGEMENT · {error}
            </div>
          )}
          {job && (
            <>
              <Section title="STATUT">
                <KV
                  k="ÉTAT"
                  v={
                    <span
                      style={{
                        color: STATUS_COLOR[job.status] ?? "#FFFFFF",
                      }}
                    >
                      {STATUS_LABEL_FR[job.status] ?? job.status.toUpperCase()}
                      {job.stopRequested ? " · STOP REQUESTED" : ""}
                    </span>
                  }
                />
                <KV k="TRIGGER" v={triggerLabel(job.trigger)} />
                <KV
                  k="PLATEFORME"
                  v={job.platform ? shortPlatform(job.platform) : "—"}
                />
              </Section>

              <Section title="TIMING">
                <KV k="LANCÉ" v={long(job.startedAt)} />
                <KV k="TERMINÉ" v={job.endedAt ? long(job.endedAt) : "EN COURS"} />
                <KV k="DURÉE" v={duration(job.startedAt, job.endedAt)} />
              </Section>

              <Section title="RÉSUMÉ">
                <p className="normal-case text-white tracking-wide leading-relaxed">
                  {summary(job)}
                </p>
              </Section>

              {job.error && (
                <Section title="ERREUR">
                  <pre className="normal-case text-[#FF3300] tracking-wide whitespace-pre-wrap break-words bg-[#0D0D0D] border border-[#FF3300]/40 p-3 text-[11px] leading-relaxed">
                    {job.error}
                  </pre>
                </Section>
              )}

              <Section title="STATS BRUTES">
                <pre className="normal-case text-[#CCCCCC] tracking-normal whitespace-pre-wrap break-words bg-[#0D0D0D] border border-[#666666]/30 p-3 text-[11px] leading-relaxed max-h-96 overflow-y-auto">
                  {job.stats
                    ? JSON.stringify(job.stats, null, 2)
                    : "(aucune stat)"}
                </pre>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] text-[#FF3300] tracking-widest border-b border-[#FF3300]/40 pb-1">
        [ {title} ]
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[#666666]">{k}</span>
      <span className="text-white text-right truncate">{v}</span>
    </div>
  );
}

// ── formatting helpers ──────────────────────────────────────────────
function short(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
function long(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}
function shortPlatform(p: string): string {
  if (p === "instagram") return "IG";
  if (p === "tiktok") return "TT";
  if (p === "both") return "IG+TT";
  return p.toUpperCase();
}
function poolSuffix(job: { stats: Record<string, unknown> | null }): string {
  const poolType = (job.stats as { poolType?: string } | null)?.poolType;
  if (poolType === "follower") return " · ABONNÉS";
  if (poolType === "engagement") return " · ENGAGEMENT";
  return "";
}
function triggerLabel(t: string): string {
  if (t === "manual") return "MANUEL";
  if (t === "cron") return "CRON";
  if (t === "auto_refill") return "AUTO-REFILL";
  return t.toUpperCase();
}
function duration(startedAt: string, endedAt: string | null): string {
  const s = new Date(startedAt).getTime();
  const e = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = Math.max(0, e - s);
  if (ms < 60_000) return `${Math.round(ms / 1000)}S`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}M ${Math.round((ms % 60_000) / 1000)}S`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}H ${m}M`;
}

function summary(r: JobRow): string {
  const s = r.stats as Record<string, unknown> | null;
  if (!s) return "—";
  if (r.jobType === "scrape") {
    const addedA = Number(s.addedA ?? 0);
    const addedB = Number(s.addedB ?? 0);
    const target = Number(s.target ?? 0);
    const calls = Number(s.callsUsed ?? 0);
    const skipped = Boolean(s.phaseBSkipped);
    return `+${(addedA + addedB).toLocaleString("en-US")}/${target.toLocaleString(
      "en-US"
    )} COMPTES · ${calls.toLocaleString("en-US")} CALLS${
      skipped ? " · PHASE B SKIP" : ""
    }`;
  }
  if (r.jobType === "health_check") {
    const checked = Number(s.checked ?? 0);
    const invalidated = Number(s.invalidated ?? 0);
    const calls = Number(s.callsUsed ?? 0);
    return `${checked.toLocaleString("en-US")} CHECKS · ${invalidated.toLocaleString(
      "en-US"
    )} INVALIDÉS · ${calls.toLocaleString("en-US")} CALLS`;
  }
  return "—";
}
