"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { useActivity } from "@/components/ActivityContext";

type Trigger = {
  label: string;
  running: string;
  endpoint: string;
  renderResult?: (data: Record<string, unknown>) => string;
};

const TRIGGERS: Trigger[] = [
  {
    label: "SYNCHRONISER LES SERVICES",
    running: "SYNCHRONISATION...",
    endpoint: "/api/config/sync-services",
  },
  {
    label: "RE-PARSE TYPES (MIGRATION)",
    running: "RE-PARSE...",
    endpoint: "/api/config/reparse-types",
    renderResult: (d) => {
      const corrected = Number(d.corrected ?? 0);
      const deactivated = Number(d.deactivatedOutOfScope ?? 0);
      const reactivated = Number(d.reactivatedBackInScope ?? 0);
      const total = Number(d.total ?? 0);
      return `OK — ${corrected}/${total} CORRIGÉS · ${deactivated} DÉSACTIVÉS · ${reactivated} RÉACTIVÉS`;
    },
  },
];

export function ConfigDangerZone() {
  const router = useRouter();
  const { show, hide } = useLoading();
  const { flash } = useActivity();
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(t: Trigger) {
    if (runningKey) return;
    setRunningKey(t.endpoint);
    setMsg(null);
    show();
    try {
      const res = await fetch(t.endpoint, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash();
        if (t.renderResult) setMsg(t.renderResult(data));
      } else {
        setMsg(`ERREUR : ${data.error ?? "INCONNUE"}`);
      }
      router.refresh();
    } catch {
      setMsg("ERREUR RÉSEAU");
    } finally {
      setTimeout(() => {
        hide();
        setRunningKey(null);
      }, 600);
    }
  }

  return (
    <section
      data-cursor="invert"
      className="w-full bg-[#FF3300] py-16 md:py-24 px-4 md:px-8 text-black flex flex-col items-center justify-center text-center"
    >
      <div className="font-mono text-xs tracking-widest mb-8 border border-black/30 px-4 py-1">
        [ ZONE DANGER ]
      </div>
      <h2 className="brand font-display text-fluid-title uppercase tracking-tight leading-none mb-6 hover:tracking-normal transition-all duration-700 interactive">
        Exécuter.
      </h2>
      <p className="font-mono text-xs tracking-widest uppercase mb-10">
        CES ACTIONS AFFECTENT LES DONNÉES LIVE.
      </p>
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3 md:gap-4 w-full max-w-2xl">
        {TRIGGERS.map((t) => {
          const running = runningKey === t.endpoint;
          const disabled = Boolean(runningKey) && !running;
          return (
            <button
              key={t.endpoint}
              type="button"
              onClick={() => run(t)}
              disabled={running || disabled}
              className="interactive flex-1 font-mono text-xs md:text-sm tracking-widest border border-black px-6 md:px-10 py-4 hover:bg-black hover:text-[#FF3300] transition-colors duration-300 disabled:opacity-60"
            >
              {running ? t.running : t.label}
            </button>
          );
        })}
      </div>
      {msg && (
        <p className="mt-6 font-mono text-xs tracking-widest uppercase max-w-2xl break-words">
          {msg}
        </p>
      )}
    </section>
  );
}
