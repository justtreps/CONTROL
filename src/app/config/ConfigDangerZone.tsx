"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { useActivity } from "@/components/ActivityContext";

export function ConfigDangerZone() {
  const router = useRouter();
  const { show, hide } = useLoading();
  const { flash } = useActivity();
  const [running, setRunning] = useState(false);

  async function sync() {
    if (running) return;
    setRunning(true);
    show();
    try {
      const res = await fetch("/api/config/sync-services", { method: "POST" });
      if (res.ok) flash();
      router.refresh();
    } finally {
      setTimeout(() => {
        hide();
        setRunning(false);
      }, 600);
    }
  }

  return (
    <section
      data-cursor="invert"
      className="w-full bg-[#FF3300] py-24 px-4 md:px-8 text-black flex flex-col items-center justify-center text-center"
    >
      <div className="font-mono text-xs tracking-widest mb-8 border border-black/30 px-4 py-1">
        [ ZONE DANGER ]
      </div>
      <h2 className="brand font-display text-fluid-title uppercase tracking-tight leading-none mb-6 hover:tracking-normal transition-all duration-700 interactive">
        Exécuter.
      </h2>
      <p className="font-mono text-xs tracking-widest uppercase mb-12">
        CES ACTIONS AFFECTENT LES DONNÉES LIVE.
      </p>
      <button
        type="button"
        onClick={sync}
        disabled={running}
        className="interactive font-mono text-sm tracking-widest border border-black px-12 py-4 hover:bg-black hover:text-[#FF3300] transition-colors duration-300 disabled:opacity-60"
      >
        {running ? "SYNCHRONISATION..." : "SYNCHRONISER LES SERVICES"}
      </button>
    </section>
  );
}
