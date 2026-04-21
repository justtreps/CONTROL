"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Collapsible } from "./Collapsible";
import { PoolSeedsCard } from "./PoolSeedsCard";
import { PoolPrefixesCard } from "./PoolPrefixesCard";
import { PoolSettings } from "./PoolSettings";
import { PoolJobsHistory } from "./PoolJobsHistory";
import { usePoolToast } from "./PoolToast";

type Cfg = React.ComponentProps<typeof PoolSettings>["initialConfig"];

// Zone 4 — advanced config wrapper. Collapsed by default so the main
// page stays focused on everyday tasks. Inside, 3 sub-sections:
//   A. COMPTES SOURCES — big-account seeds (Method A, always on)
//   B. MÉTHODE ALTERNATIVE — random-prefix probing (Method B, togglable)
//   C. PARAMÈTRES TECHNIQUES — auto-refill / quotas / cron / quality
export function PoolAdvancedConfig({ initialConfig }: { initialConfig: Cfg }) {
  return (
    <Collapsible
      banner
      label="CONFIGURATION AVANCÉE"
      hint="pour régler finement le scrape · à laisser fermé en usage normal"
    >
      {/* Sub-section A — Seeds (Method A) */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">A.</span>
          <span className="text-white">COMPTES SOURCES</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (&laquo;&nbsp;big accounts&nbsp;&raquo; dans les followers desquels on cherche
            nos comptes test)
          </span>
        </div>
        <PoolSeedsCard />
      </div>

      {/* Sub-section B — Method B (toggle + prefixes) */}
      <MethodBSection initial={initialConfig} />

      {/* Sub-section C — Technical settings */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">C.</span>
          <span className="text-white">PARAMÈTRES TECHNIQUES</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (auto-refill, quotas API, cron, critères de qualité)
          </span>
        </div>
        <PoolSettings initialConfig={initialConfig} />
      </div>

      {/* Sub-section D — Jobs history */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">D.</span>
          <span className="text-white">HISTORIQUE DES JOBS</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (tous les scrapes, vérifications et nettoyages passés — click une
            ligne pour voir le détail)
          </span>
        </div>
        <PoolJobsHistory />
      </div>
    </Collapsible>
  );
}

// ── Method B sub-section ────────────────────────────────────────────
// The toggle is the authoritative switch for Phase B. When off, we
// apply a gray overlay to the prefixes card below — it stays clickable
// so operators can still curate prefixes, but the visual weak state
// signals that whatever they do here has no effect until the method
// is re-enabled.
function MethodBSection({ initial }: { initial: Cfg }) {
  const router = useRouter();
  const toast = usePoolToast();
  const [enabled, setEnabled] = useState(initial.methodBEnabled);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    if (saving) return;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/pool/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ methodBEnabled: next }),
      });
      if (res.ok) {
        toast.push(
          next ? "ok" : "err",
          `MÉTHODE 2 ${next ? "ACTIVÉE" : "DÉSACTIVÉE"}`
        );
        router.refresh();
      } else {
        setEnabled(!next);
        toast.push("err", "ÉCHEC SAUVEGARDE");
      }
    } catch {
      setEnabled(!next);
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
        <span className="text-[#FF3300]">B.</span>
        <span className="text-white">MÉTHODE ALTERNATIVE</span>
        <span className="normal-case text-[#666666]/70 text-[10px]">
          (générateur de usernames random à partir de préfixes)
        </span>
      </div>

      {/* Toggle row */}
      <div className="px-4 md:px-8 py-5 bg-[#030303] border-b border-[#666666]/20 flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-white tracking-widest uppercase mb-1">
            ACTIVER CETTE MÉTHODE
          </div>
          <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed max-w-xl">
            Quand activé, le scraper tente aussi de découvrir des comptes test
            en testant des usernames aléatoires à partir des préfixes ci-dessous
            (Phase&nbsp;B). Laisse désactivé si la Méthode&nbsp;A (seeds) suffit.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={saving}
          className={`interactive border px-5 py-3 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-60 ${
            enabled
              ? "border-[#FF3300] bg-[#FF3300] text-black"
              : "border-[#666666]/40 text-[#666666] hover:border-white hover:text-white"
          }`}
          aria-pressed={enabled}
        >
          {enabled ? "[ ACTIVÉE ]" : "[ DÉSACTIVÉE ]"}
        </button>
      </div>

      {/* Prefixes card with dimming overlay when disabled */}
      <div className="relative">
        <PoolPrefixesCard />
        {!enabled && (
          <div
            className="absolute inset-0 bg-[#030303]/70 backdrop-blur-[1px] pointer-events-none flex items-start justify-center pt-8"
            aria-hidden="true"
          >
            <span className="font-mono text-[11px] text-[#666666] tracking-widest uppercase border border-[#666666]/40 px-3 py-1 bg-[#030303]">
              [ MÉTHODE DÉSACTIVÉE — ACTIVE LE TOGGLE CI-DESSUS POUR ÉDITER ]
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
