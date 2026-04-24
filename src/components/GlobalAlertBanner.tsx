"use client";

// Sticky banner mounted in the root layout. Polls
// /api/alerts/counts every 30s. Renders only when >=1 active alert
// of severity ≥ warning (info-only doesn't clutter the banner).
//
// Colour rules:
//   ≥1 critical                    → red bar
//   ≥1 warning (no critical)       → orange bar
//   only info / acknowledged / none → nothing

import Link from "next/link";
import { useEffect, useState } from "react";

type Counts = {
  critical: number;
  warning: number;
  info: number;
  total: number;
  acknowledged: number;
};

export function GlobalAlertBanner() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/alerts/counts", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as Counts;
        if (!cancelled) setCounts(d);
      } catch {
        /* swallow */
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!counts) return null;
  if (counts.critical === 0 && counts.warning === 0) return null;

  const critical = counts.critical > 0;
  const bg = critical ? "bg-[#FF3300]" : "bg-[#FFCC00]";
  const fg = "text-black";
  const icon = "⚠";
  const label = critical
    ? `${counts.critical} ALERTE${counts.critical > 1 ? "S" : ""} CRITIQUE${
        counts.critical > 1 ? "S" : ""
      }${counts.warning > 0 ? ` + ${counts.warning} WARNING` : ""}`
    : `${counts.warning} WARNING${counts.warning > 1 ? "S" : ""}`;

  return (
    <div
      className={`${bg} ${fg} px-4 md:px-8 py-2 flex items-center justify-between gap-3 sticky top-0 z-[9997] font-mono text-xs tracking-widest uppercase`}
    >
      <span className="flex items-center gap-2">
        <span>{icon}</span>
        <span>{label}</span>
      </span>
      <Link
        href="/alertes"
        className="interactive border border-black hover:bg-black hover:text-white transition-colors px-3 py-1 text-[11px] tracking-widest uppercase"
      >
        [ VOIR → ]
      </Link>
    </div>
  );
}
