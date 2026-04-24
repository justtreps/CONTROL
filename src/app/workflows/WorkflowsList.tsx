"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Row = {
  id: number;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  triggerType: string;
  cronExpression: string | null;
  eventType: string | null;
  isActive: boolean;
  nodeCount: number;
  lastRun: {
    status: string;
    trigger: string;
    startedAt: string;
  } | null;
};

const CATEGORY_COLOR: Record<string, string> = {
  health: "#00CC66",
  pool: "#FF3300",
  scoring: "#FFCC00",
  sync: "#66CCFF",
  catalogue: "#FF66CC",
  custom: "#CCCCCC",
};

export function WorkflowsList({
  initial,
  executorEnabled,
}: {
  initial: Row[];
  executorEnabled: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function toggle(slug: string, isActive: boolean) {
    if (busy[slug]) return;
    setBusy((b) => ({ ...b, [slug]: true }));
    try {
      const res = await fetch(`/api/workflows/${slug}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      if (res.ok) {
        setRows((xs) =>
          xs.map((r) => (r.slug === slug ? { ...r, isActive: !isActive } : r))
        );
        router.refresh();
      }
    } finally {
      setBusy((b) => ({ ...b, [slug]: false }));
    }
  }

  async function run(slug: string) {
    if (busy[slug]) return;
    setBusy((b) => ({ ...b, [slug]: true }));
    try {
      await fetch(`/api/workflows/${slug}/run`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy((b) => ({ ...b, [slug]: false }));
    }
  }

  return (
    <section className="px-4 md:px-8 pb-24">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 border-y border-[#666666]/20">
        {rows.map((r, idx) => {
          const bg = idx % 2 === 0 ? "bg-[#030303]" : "bg-[#0D0D0D]";
          const color = CATEGORY_COLOR[r.category] ?? "#CCCCCC";
          return (
            <div
              key={r.slug}
              className={`${bg} border border-[#666666]/20 p-5 md:p-6 flex flex-col gap-3`}
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className="font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
                  style={{ color, borderColor: color }}
                >
                  {r.category}
                </span>
                <span
                  className={`font-mono text-[10px] tracking-widest uppercase ${
                    r.isActive ? "text-[#00CC66]" : "text-[#666666]"
                  }`}
                >
                  {r.isActive ? "ACTIF" : "INACTIF"}
                </span>
              </div>
              <h3 className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white leading-tight m-0">
                {r.displayName}
              </h3>
              <p className="font-mono text-[11px] text-[#999999] normal-case leading-snug min-h-[2.5rem]">
                {r.description}
              </p>
              <div className="flex flex-col gap-1 font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case">
                <div>
                  Trigger :{" "}
                  <span className="text-white">
                    {r.triggerType === "cron"
                      ? `cron ${r.cronExpression ?? ""}`
                      : r.triggerType === "event"
                        ? `event ${r.eventType ?? ""}`
                        : "manual"}
                  </span>
                </div>
                <div>
                  Nodes : <span className="text-white">{r.nodeCount}</span>
                </div>
                <div>
                  Dernier run :{" "}
                  {r.lastRun ? (
                    <span
                      className={
                        r.lastRun.status === "completed"
                          ? "text-[#00CC66]"
                          : r.lastRun.status === "failed"
                            ? "text-[#FF3300]"
                            : r.lastRun.status === "paused"
                              ? "text-[#FFCC00]"
                              : "text-white"
                      }
                    >
                      {r.lastRun.status.toUpperCase()} ·{" "}
                      {formatAge(r.lastRun.startedAt)}
                    </span>
                  ) : (
                    <span className="text-[#666666]">jamais</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-auto pt-3">
                <Link
                  href={`/workflows/${r.slug}`}
                  className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase"
                >
                  [ ÉDITER → ]
                </Link>
                <button
                  type="button"
                  onClick={() => run(r.slug)}
                  disabled={busy[r.slug] || !r.isActive}
                  className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
                  title={
                    !r.isActive
                      ? "Réactive d'abord le workflow"
                      : !executorEnabled
                        ? "Kill switch OFF — le run tournera quand même via le bouton manuel"
                        : undefined
                  }
                >
                  [ LANCER ]
                </button>
                <button
                  type="button"
                  onClick={() => toggle(r.slug, r.isActive)}
                  disabled={busy[r.slug]}
                  className={
                    "interactive border px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50 " +
                    (r.isActive
                      ? "border-[#666666]/40 text-[#666666] hover:text-white hover:border-white"
                      : "border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black")
                  }
                >
                  {r.isActive ? "[ DÉSACTIVER ]" : "[ RÉACTIVER ]"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatAge(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days}j`;
}
