"use client";

import { useEffect, useState } from "react";
import type { PoolStats } from "@/lib/pool/stats";

// Zone 1 stat cards — plain-French version of the hero numbers. Four
// Pattern-C cards, one per lifecycle bucket, summed across IG+TT so a
// non-dev user sees "combien de comptes dispo en tout" at a glance.
type Props = { initialStats: PoolStats };

export function PoolOverviewCards({ initialStats }: Props) {
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

  const ig = stats.instagram;
  const tt = stats.tiktok;
  const total = {
    available: ig.available + tt.available,
    assigned: ig.assigned + tt.assigned,
    consumed: ig.consumed + tt.consumed,
    invalid: ig.invalid + tt.invalid,
    target: ig.target + tt.target,
  };
  const pct = Math.min(
    100,
    Math.round((total.available / Math.max(1, total.target)) * 100)
  );

  return (
    <section className="w-full">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 w-full border-b border-[#666666]/20">
        <Card
          num="01"
          label="DISPO"
          help="Comptes test prêts à être utilisés sur une commande."
          value={total.available}
          sub={`${pct}% DU STOCK CIBLE (${total.target.toLocaleString("en-US")})`}
          accent
          igValue={ig.available}
          ttValue={tt.available}
          igTarget={ig.target}
          ttTarget={tt.target}
        />
        <Card
          num="02"
          label="EN USAGE"
          help="Comptes actuellement assignés à une commande en cours."
          value={total.assigned}
          sub="ASSIGNÉS À UNE COMMANDE EN COURS"
          igValue={ig.assigned}
          ttValue={tt.assigned}
          bg="bg-[#0D0D0D]"
          borderRight
        />
        <Card
          num="03"
          label="DÉJÀ UTILISÉS"
          help="Commande terminée — compte consommé, jamais réutilisé."
          value={total.consumed}
          sub="COMMANDE TERMINÉE · NON RÉUTILISÉS"
          igValue={ig.consumed}
          ttValue={tt.consumed}
          borderRight
        />
        <Card
          num="04"
          label="CASSÉS"
          help="Supprimés, devenus actifs, devenus privés, bannis, etc."
          value={total.invalid}
          sub="INVALIDES · HORS SERVICE"
          igValue={ig.invalid}
          ttValue={tt.invalid}
          bg="bg-[#0D0D0D]"
        />
      </div>
    </section>
  );
}

function Card({
  num,
  label,
  help,
  value,
  sub,
  accent = false,
  igValue,
  ttValue,
  igTarget,
  ttTarget,
  bg = "bg-[#030303]",
  borderRight = false,
}: {
  num: string;
  label: string;
  help: string;
  value: number;
  sub: string;
  accent?: boolean;
  igValue: number;
  ttValue: number;
  igTarget?: number;
  ttTarget?: number;
  bg?: string;
  borderRight?: boolean;
}) {
  return (
    <div
      className={`relative p-6 md:p-8 ${bg} ${
        borderRight ? "xl:border-r border-[#666666]/20" : ""
      } border-b md:border-b-0 md:border-r xl:border-b-0 border-[#666666]/20 last:border-r-0`}
    >
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-xs text-[#FF3300] tracking-widest">
          {num}
        </span>
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          {label}
        </span>
      </div>
      <div
        className={`brand font-display text-4xl md:text-5xl uppercase tracking-tight tabular-nums leading-none mb-3 ${
          accent ? "text-[#FF3300]" : "text-white"
        }`}
      >
        {value.toLocaleString("en-US")}
      </div>
      <p className="font-mono text-[11px] text-white tracking-widest uppercase mb-2">
        {sub}
      </p>
      <p className="font-mono text-[10px] text-[#666666] tracking-wide leading-relaxed normal-case">
        {help}
      </p>
      <div className="mt-4 pt-3 border-t border-[#666666]/20 flex flex-col gap-1 font-mono text-[10px] tracking-widest uppercase">
        <SubRow
          plat="IG"
          value={igValue}
          target={igTarget}
        />
        <SubRow
          plat="TT"
          value={ttValue}
          target={ttTarget}
        />
      </div>
    </div>
  );
}

function SubRow({
  plat,
  value,
  target,
}: {
  plat: string;
  value: number;
  target?: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#666666]">{plat}</span>
      <span className="text-white tabular-nums">
        {value.toLocaleString("en-US")}
        {target !== undefined && (
          <span className="text-[#666666]"> / {target.toLocaleString("en-US")}</span>
        )}
      </span>
    </div>
  );
}
