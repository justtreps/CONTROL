"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";

type Toggles = {
  poolScrapeEnabled: boolean;
  poolHealthcheckEnabled: boolean;
  routingApiEnabled: boolean;
  testBotEnabled: boolean;
  scoringEngineEnabled: boolean;
  adaptivePollingEnabled: boolean;
};

type Row = {
  key: keyof Toggles;
  label: string;
  hint?: string;
};

const ROWS: Row[] = [
  { key: "poolScrapeEnabled", label: "SCRAPE COMPTES TEST", hint: "/api/pool/scrape + orchestrator" },
  { key: "poolHealthcheckEnabled", label: "HEALTH CHECK", hint: "daily cron + manual run" },
  { key: "routingApiEnabled", label: "ROUTING API", hint: "/api/order (MyBoost)" },
  { key: "testBotEnabled", label: "TEST BOT", hint: "BulkMedya calls → simulated" },
  { key: "scoringEngineEnabled", label: "SCORING ENGINE", hint: "/api/cron/scoring" },
  {
    key: "adaptivePollingEnabled",
    label: "POLLING ADAPTATIF",
    hint: "testbot-poll · 5min↔4h (off = 30min fixe)",
  },
];

export function SystemKillSwitch({ initialToggles }: { initialToggles: Toggles }) {
  const router = useRouter();
  const toast = usePoolToast();
  const [toggles, setToggles] = useState<Toggles>(initialToggles);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/system/toggles", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { toggles: Toggles };
      setToggles(d.toggles);
    } catch {
      /* swallow */
    }
  }, []);

  // Poll every 30s so two operators editing in parallel see each other.
  useEffect(() => {
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function setOne(key: keyof Toggles, value: boolean) {
    if (busy) return;
    setBusy(true);
    const prev = toggles;
    setToggles((t) => ({ ...t, [key]: value }));
    try {
      const res = await fetch("/api/system/toggles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (res.ok) {
        toast.push("ok", `${key.toUpperCase()} ${value ? "ENABLED" : "DISABLED"}`);
        router.refresh();
      } else {
        setToggles(prev);
        toast.push("err", "UPDATE FAILED");
      }
    } catch {
      setToggles(prev);
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    if (busy) return;
    if (!confirm("Couper TOUS les systèmes ?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/system/stop-all", { method: "POST" });
      if (res.ok) {
        const d = (await res.json()) as { toggles: Toggles };
        setToggles(d.toggles);
        toast.push("err", "ALL SYSTEMS PAUSED");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function restartAll() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/system/restart-all", { method: "POST" });
      if (res.ok) {
        const d = (await res.json()) as { toggles: Toggles };
        setToggles(d.toggles);
        toast.push("ok", "ALL SYSTEMS RESUMED");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const disabledCount = ROWS.filter((r) => !toggles[r.key]).length;

  return (
    <section
      id="kill-switch"
      data-cursor="invert"
      className="w-full scroll-mt-20 border-b border-black"
    >
      {/* Banner Pattern F compact */}
      <div className="bg-[#FF3300] text-black px-4 md:px-8 h-24 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs tracking-widest border border-black/30 px-3 py-1">
            [ SYSTEM CONTROL ]
          </span>
          {disabledCount > 0 && (
            <span className="font-mono text-xs tracking-widest hidden sm:inline">
              {disabledCount}/{ROWS.length} PAUSED
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="interactive border border-black bg-black text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-5 py-3 font-mono text-xs md:text-sm tracking-widest uppercase"
          aria-expanded={open}
        >
          {open ? "[ ⚠ KILL SWITCH ▴ ]" : "[ ⚠ KILL SWITCH ▾ ]"}
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="bg-[#030303] border-t-2 border-[#FF3300]">
          <div className="max-w-4xl mx-auto">
            <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-b border-[#666666]/20">
              [ SYSTEMS STATUS | {ROWS.length} TOGGLES ]
            </div>
            <div className="border-b border-[#666666]/20">
              {ROWS.map((r) => {
                const on = toggles[r.key];
                return (
                  <div
                    key={r.key}
                    className="flex items-center justify-between gap-3 px-4 md:px-8 py-4 border-b border-[#666666]/10 font-mono text-xs md:text-sm tracking-widest uppercase hover:bg-[#0D0D0D]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-white truncate">{r.label}</div>
                      {r.hint && (
                        <div className="font-mono text-[10px] text-[#666666] tracking-widest mt-1 truncate">
                          {r.hint}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setOne(r.key, !on)}
                      disabled={busy}
                      className={`interactive border px-4 py-2 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-60 flex-shrink-0 ${
                        on
                          ? "border-[#FF3300] bg-[#FF3300] text-black"
                          : "border-[#666666]/40 text-[#666666] hover:border-white hover:text-white"
                      }`}
                    >
                      {on ? "[ ENABLED ]" : "[ DISABLED ]"}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 px-4 md:px-8 py-4">
              <button
                type="button"
                onClick={stopAll}
                disabled={busy || disabledCount === ROWS.length}
                className="interactive flex-1 border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black py-3 px-4 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-50"
              >
                [ ⚠ STOP ALL ]
              </button>
              <button
                type="button"
                onClick={restartAll}
                disabled={busy || disabledCount === 0}
                className="interactive flex-1 border border-white text-white hover:bg-white hover:text-black py-3 px-4 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-50"
              >
                [ ▶ RESTART ALL ]
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
