"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/Skeleton";

// Read-only 20-line table of the most recent PoolSeedHealthLog entries.
// Rendered inside a <Collapsible> at the bottom of the seeds sub-section.
// Refreshable on demand; also auto-refreshes when the parent fires a
// manual trigger (parent passes a `refreshKey` that bumps on trigger).
type LogRow = {
  id: number;
  platform: string;
  action: string;
  seedUsername: string;
  newUsername: string | null;
  reason: string | null;
  createdAt: string;
};

type Props = {
  /** Incremented by the parent after a manual-trigger completes, so we re-fetch. */
  refreshKey?: number;
};

const ACTION_LABEL: Record<string, { label: string; color: string }> = {
  ok: { label: "OK", color: "#666666" },
  renamed: { label: "RENOMMÉ", color: "#FFCC00" },
  deleted_mort: { label: "SUPPRIMÉ", color: "#FF3300" },
  replaced_from_cache: { label: "REMPLACÉ (CACHE)", color: "#10B981" },
  cache_empty_refill_triggered: {
    label: "CACHE VIDE → REFILL",
    color: "#FF3300",
  },
  error: { label: "ERREUR", color: "#FF3300" },
  manual_trigger: { label: "DÉCLENCHEMENT MANUEL", color: "#FFCC00" },
};

export function PoolSeedsHealthLog({ refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/pool/seeds/health-log?limit=20", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const d = (await res.json()) as { rows: LogRow[] };
      setRows(d.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  return (
    <div className="bg-[#030303]">
      <div className="flex items-center justify-between gap-3 px-4 md:px-6 py-3 border-b border-[#666666]/20 bg-[#0D0D0D]">
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          20 DERNIÈRES ACTIONS
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-3 py-1 font-mono text-[10px] tracking-widest uppercase transition-colors disabled:opacity-60"
          aria-label="Rafraîchir l'historique"
        >
          [ ↻ RAFRAÎCHIR ]
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-[10px] uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-3 py-2 font-normal">Date</th>
              <th className="text-left px-3 py-2 font-normal">Plat.</th>
              <th className="text-left px-3 py-2 font-normal">Action</th>
              <th className="text-left px-3 py-2 font-normal">Seed</th>
              <th className="text-left px-3 py-2 font-normal">Détails</th>
            </tr>
          </thead>
          <tbody aria-busy={loading}>
            {loading && rows.length === 0 && (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-[#666666]/20">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="px-3 py-2">
                        <Skeleton height={10} className="w-full max-w-[10rem]" />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            )}
            {rows.map((r) => {
              const cfg = ACTION_LABEL[r.action] ?? {
                label: r.action.toUpperCase(),
                color: "#666666",
              };
              return (
                <tr
                  key={r.id}
                  className="border-b border-[#666666]/20 hover:bg-[#0D0D0D]"
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] tabular-nums whitespace-nowrap">
                    {formatDate(r.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] tracking-widest uppercase">
                    {r.platform === "all"
                      ? "ALL"
                      : r.platform === "instagram"
                        ? "IG"
                        : r.platform === "tiktok"
                          ? "TT"
                          : r.platform.toUpperCase()}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] tracking-widest uppercase whitespace-nowrap">
                    <span style={{ color: cfg.color }}>{cfg.label}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-white truncate max-w-[12rem]">
                    {r.seedUsername ? `@${r.seedUsername}` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] normal-case truncate max-w-md">
                    {r.newUsername && (
                      <span className="text-white">→ @{r.newUsername}</span>
                    )}
                    {r.newUsername && r.reason && " · "}
                    {r.reason && (
                      <span title={r.reason}>{r.reason.slice(0, 80)}</span>
                    )}
                    {!r.newUsername && !r.reason && "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <div className="px-4 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
            AUCUNE ACTION ENREGISTRÉE — ATTENDS LE PREMIER CRON 3H UTC
            OU LANCE UNE VÉRIFICATION MANUELLE.
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}
