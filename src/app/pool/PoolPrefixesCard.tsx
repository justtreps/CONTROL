"use client";

import { useCallback, useEffect, useState } from "react";
import { usePoolToast } from "./PoolToast";

type Prefix = {
  id: number;
  prefix: string;
  enabled: boolean;
};

const INPUT_CLS =
  "interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

export function PoolPrefixesCard() {
  const toast = usePoolToast();
  const [rows, setRows] = useState<Prefix[]>([]);
  const [addPrefix, setAddPrefix] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/pool/prefixes", { cache: "no-store" });
    if (res.ok) {
      const d = (await res.json()) as { rows: Prefix[] };
      setRows(d.rows);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add() {
    const p = addPrefix.trim().toLowerCase();
    if (!p) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pool/prefixes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: p }),
      });
      if (res.ok) {
        toast.push("ok", `PREFIX ${p} ADDED`);
        setAddPrefix("");
        await refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.push("err", d.error ?? "ADD FAILED");
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: Prefix) {
    const res = await fetch(`/api/pool/prefixes/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    if (res.ok) await refresh();
  }

  async function remove(p: Prefix) {
    if (!confirm(`Supprimer le prefix "${p.prefix}" ?`)) return;
    const res = await fetch(`/api/pool/prefixes/${p.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.push("ok", `PREFIX ${p.prefix} DELETED`);
      await refresh();
    }
  }

  const enabledCount = rows.filter((r) => r.enabled).length;

  return (
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
        [ USERNAME PREFIXES METHOD B | {enabledCount}/{rows.length} ACTIVE ]
      </div>
      <div className="p-6 md:p-8 bg-[#030303] border-b border-[#666666]/20">
        <p className="font-mono text-[11px] text-[#666666] tracking-widest uppercase mb-4 leading-relaxed">
          PRÉFIXES UTILISÉS POUR GÉNÉRER DES USERNAMES RANDOM (METHOD B).
          CLICK POUR TOGGLE ENABLED · × POUR SUPPRIMER.
        </p>

        <div className="flex flex-wrap gap-2 mb-6">
          {rows.map((p) => (
            <span
              key={p.id}
              className={`group inline-flex items-center gap-2 border px-3 py-1 font-mono text-xs tracking-widest uppercase transition-colors ${
                p.enabled
                  ? "border-[#FF3300] text-[#FF3300]"
                  : "border-[#666666]/40 text-[#666666]/60"
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(p)}
                className="interactive"
              >
                {p.prefix}
              </button>
              <button
                type="button"
                onClick={() => remove(p)}
                className="interactive opacity-0 group-hover:opacity-100 text-[#FF3300] hover:text-white transition-opacity"
                aria-label="Supprimer"
              >
                ×
              </button>
            </span>
          ))}
          {rows.length === 0 && (
            <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
              AUCUN PRÉFIXE.
            </span>
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={addPrefix}
            onChange={(e) => setAddPrefix(e.target.value)}
            placeholder="PREFIX (ex: mike)"
            className={`${INPUT_CLS} flex-1 min-w-[160px]`}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button
            type="button"
            onClick={add}
            disabled={busy || !addPrefix.trim()}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
          >
            [ + ADD PREFIX ]
          </button>
        </div>
      </div>
    </section>
  );
}
