"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { usePoolToast } from "./PoolToast";
import type { ActivePool } from "./PoolUniverseSwitch";

// Zone 2 — unified action card. Replaces the old 3-card PoolControls.
// Combines:
//   • Auto-refill toggle + threshold summary
//   • Primary SCRAPE action (platform + count + big red button)
//   • Secondary HEALTH CHECK action
//
// Scoped to `activePool`: the scrape + health-check buttons pass
// their universe as poolType so the backend filters accordingly
// (follower-only or engagement-only candidates / accounts).
type Props = {
  activePool: ActivePool;
  initialConfig: {
    autoRefillEnabled: boolean;
    refillThresholdInstagram: number;
    refillTargetInstagram: number;
    refillThresholdTiktok: number;
    refillTargetTiktok: number;
  };
};

export function PoolUnifiedActions({ activePool, initialConfig }: Props) {
  const poolApiValue = activePool === "follower" ? "follower" : "engagement";
  const poolLabel = activePool === "follower" ? "ABONNÉS" : "ENGAGEMENT";
  const isEngagement = activePool === "engagement";
  const router = useRouter();
  const { show, hide } = useLoading();
  const toast = usePoolToast();

  const [autoRefill, setAutoRefill] = useState(initialConfig.autoRefillEnabled);
  const [savingAutoRefill, setSavingAutoRefill] = useState(false);

  const [scrapePlatform, setScrapePlatform] = useState<
    "instagram" | "tiktok" | "both"
  >("both");
  const [scrapeCount, setScrapeCount] = useState(1000);
  const [scrapeRunning, setScrapeRunning] = useState(false);

  const [extractRunning, setExtractRunning] = useState(false);

  const [healthPlatform, setHealthPlatform] = useState<
    "instagram" | "tiktok" | "both"
  >("both");
  const [healthRunning, setHealthRunning] = useState(false);

  async function toggleAutoRefill() {
    if (savingAutoRefill) return;
    const next = !autoRefill;
    setAutoRefill(next);
    setSavingAutoRefill(true);
    try {
      const res = await fetch("/api/pool/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRefillEnabled: next }),
      });
      if (res.ok) {
        toast.push("ok", `AUTO-REFILL ${next ? "ACTIVÉ" : "DÉSACTIVÉ"}`);
        router.refresh();
      } else {
        setAutoRefill(!next);
        toast.push("err", "ÉCHEC SAUVEGARDE");
      }
    } catch {
      setAutoRefill(!next);
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setSavingAutoRefill(false);
    }
  }

  async function runScrape() {
    if (scrapeRunning) return;
    setScrapeRunning(true);
    show();
    try {
      const res = await fetch("/api/pool/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: scrapePlatform,
          count: scrapeCount,
          poolType: poolApiValue,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.push("ok", `SCRAPE #${data.jobId} · ${poolLabel} LANCÉ`);
        router.refresh();
      } else {
        toast.push("err", data.error ?? "ÉCHEC");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setTimeout(() => {
        hide();
        setScrapeRunning(false);
      }, 600);
    }
  }

  async function runExtract() {
    if (extractRunning) return;
    setExtractRunning(true);
    show();
    try {
      const res = await fetch("/api/pool/engagement-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: scrapePlatform,
          count: scrapeCount,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.push("ok", `EXTRACT #${data.jobId} LANCÉ`);
        router.refresh();
      } else {
        toast.push("err", data.error ?? "ÉCHEC");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setTimeout(() => {
        hide();
        setExtractRunning(false);
      }, 600);
    }
  }

  async function runHealthCheck() {
    if (healthRunning) return;
    setHealthRunning(true);
    show();
    try {
      const res = await fetch("/api/pool/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: healthPlatform,
          poolType: poolApiValue,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.push("ok", `VÉRIFICATION #${data.jobId} · ${poolLabel} LANCÉE`);
        router.refresh();
      } else {
        toast.push("err", data.error ?? "ÉCHEC");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setTimeout(() => {
        hide();
        setHealthRunning(false);
      }, 600);
    }
  }

  return (
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D] flex items-center gap-3 flex-wrap">
        <span>[ ACTIONS · {poolLabel} ]</span>
        <span className="normal-case text-[#666666]/70 text-[10px]">
          scrape et vérification ciblent uniquement ce pool
        </span>
      </div>

      {/* Auto-refill strip */}
      <div className="grid grid-cols-1 lg:grid-cols-12 border-b border-[#666666]/20">
        <div className="lg:col-span-5 p-6 md:p-8 bg-[#030303] lg:border-r border-[#666666]/20">
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              01
            </span>
            <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
              AUTO-REFILL
            </span>
          </div>
          <h3 className="brand font-display text-2xl md:text-3xl uppercase tracking-tight text-white mb-3">
            Remplissage auto.
          </h3>
          <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case mb-5 leading-relaxed">
            Lance automatiquement un scrape quand le stock &laquo;&nbsp;DISPO&nbsp;&raquo; passe
            sous le seuil, jusqu&rsquo;&agrave; atteindre la cible. Change les seuils dans la
            configuration avanc&eacute;e &darr;.
          </p>
          <button
            type="button"
            onClick={toggleAutoRefill}
            disabled={savingAutoRefill}
            className={`interactive w-full border py-3 px-4 flex items-center justify-between font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-60 ${
              autoRefill
                ? "border-[#FF3300] bg-[#FF3300] text-black"
                : "border-[#666666]/40 text-[#666666] hover:border-white hover:text-white"
            }`}
          >
            <span>STATUT</span>
            <span>{autoRefill ? "[ ACTIVÉ ]" : "[ DÉSACTIVÉ ]"}</span>
          </button>
          <div className="mt-4 flex flex-col gap-1 font-mono text-[11px] tracking-widest uppercase">
            <Row
              label="IG"
              value={`${initialConfig.refillThresholdInstagram.toLocaleString(
                "en-US"
              )} → ${initialConfig.refillTargetInstagram.toLocaleString("en-US")}`}
            />
            <Row
              label="TT"
              value={`${initialConfig.refillThresholdTiktok.toLocaleString(
                "en-US"
              )} → ${initialConfig.refillTargetTiktok.toLocaleString("en-US")}`}
            />
            <div className="text-[10px] text-[#666666] normal-case mt-1">
              Seuil &rarr; Cible &middot; en comptes DISPO.
            </div>
          </div>
        </div>

        {/* SCRAPE / EXTRACT — primary action (different in engagement mode) */}
        <div className="lg:col-span-4 p-6 md:p-8 bg-[#0D0D0D] lg:border-r border-[#666666]/20">
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              02
            </span>
            <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
              {isEngagement ? "AJOUTER DES POSTS" : "AJOUTER DES COMPTES"}
            </span>
          </div>
          <h3 className="brand font-display text-2xl md:text-3xl uppercase tracking-tight text-white mb-3">
            {isEngagement ? "Extraire." : "Scraper."}
          </h3>
          <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case mb-5 leading-relaxed">
            {isEngagement ? (
              <>
                Exploite d&apos;abord le{" "}
                <span className="text-white">pool abonnés existant</span>{" "}
                (1 appel API / compte, très cheap). Bouton secondaire si
                épuisé : scrape via seeds (2 appels / compte).
              </>
            ) : (
              <>
                Lance un job qui va remplir la r&eacute;serve{" "}
                <span className="text-white">{poolLabel.toLowerCase()}</span>{" "}
                avec de nouveaux comptes.
              </>
            )}
          </p>
          <div className="flex flex-col gap-3">
            <LabelSelect
              label="PLATEFORME"
              value={scrapePlatform}
              onChange={(v) => setScrapePlatform(v as typeof scrapePlatform)}
              options={[
                { value: "both", label: "INSTAGRAM + TIKTOK" },
                { value: "instagram", label: "INSTAGRAM SEUL" },
                { value: "tiktok", label: "TIKTOK SEUL" },
              ]}
            />
            <LabelInput
              label={isEngagement ? "COMBIEN DE POSTS" : "COMBIEN DE COMPTES"}
              type="number"
              min={1}
              max={10000}
              value={scrapeCount}
              onChange={(e) =>
                setScrapeCount(Math.max(1, Number(e.target.value) || 1000))
              }
            />
            {isEngagement ? (
              <>
                <button
                  type="button"
                  onClick={runExtract}
                  disabled={extractRunning}
                  className="interactive group relative w-full border border-[#FF3300] bg-[#FF3300] text-black py-4 px-5 flex justify-between items-center text-left disabled:opacity-60 mt-1"
                >
                  <span className="font-mono text-xs tracking-widest">
                    {extractRunning
                      ? "[ LANCEMENT... ]"
                      : "[ EXTRAIRE POSTS DU POOL ABONNÉS ]"}
                  </span>
                  <span className="font-mono text-xs">→</span>
                </button>
                <button
                  type="button"
                  onClick={runScrape}
                  disabled={scrapeRunning}
                  className="interactive group relative w-full border border-[#666666]/50 bg-transparent text-[#666666] hover:border-white hover:text-white py-3 px-5 flex justify-between items-center text-left disabled:opacity-60 transition-colors"
                >
                  <span className="font-mono text-xs tracking-widest">
                    {scrapeRunning
                      ? "[ LANCEMENT... ]"
                      : "[ SCRAPER VIA SEEDS ]"}
                  </span>
                  <span className="font-mono text-xs">→</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={runScrape}
                disabled={scrapeRunning}
                className="interactive group relative w-full border border-[#FF3300] bg-[#FF3300] text-black py-4 px-5 flex justify-between items-center text-left disabled:opacity-60 mt-1"
              >
                <span className="font-mono text-xs tracking-widest">
                  {scrapeRunning ? "[ LANCEMENT... ]" : "[ LANCER LE SCRAPE ]"}
                </span>
                <span className="font-mono text-xs">→</span>
              </button>
            )}
          </div>
        </div>

        {/* HEALTH CHECK — secondary action */}
        <div className="lg:col-span-3 p-6 md:p-8 bg-[#030303]">
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              03
            </span>
            <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
              V&Eacute;RIFIER L&apos;&Eacute;TAT
            </span>
          </div>
          <h3 className="brand font-display text-2xl md:text-3xl uppercase tracking-tight text-white mb-3">
            Contrôle.
          </h3>
          <p className="font-mono text-[11px] text-[#666666] tracking-wide normal-case mb-5 leading-relaxed">
            V&eacute;rifie que chaque compte DISPO du pool{" "}
            <span className="text-white">{poolLabel.toLowerCase()}</span> est
            toujours vierge. Invalide ceux qui ont &eacute;t&eacute;
            supprim&eacute;s / bannis / devenus actifs.
          </p>
          <div className="flex flex-col gap-3">
            <LabelSelect
              label="PLATEFORME"
              value={healthPlatform}
              onChange={(v) => setHealthPlatform(v as typeof healthPlatform)}
              options={[
                { value: "both", label: "INSTAGRAM + TIKTOK" },
                { value: "instagram", label: "INSTAGRAM SEUL" },
                { value: "tiktok", label: "TIKTOK SEUL" },
              ]}
            />
            <button
              type="button"
              onClick={runHealthCheck}
              disabled={healthRunning}
              className="interactive group relative w-full border border-white bg-transparent text-white py-4 px-5 flex justify-between items-center text-left disabled:opacity-60 hover:bg-white hover:text-black transition-colors"
            >
              <span className="font-mono text-xs tracking-widest">
                {healthRunning ? "[ LANCEMENT... ]" : "[ VÉRIFIER ]"}
              </span>
              <span className="font-mono text-xs">→</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#666666]">{label}</span>
      <span className="text-white tabular-nums">{value}</span>
    </div>
  );
}

function LabelSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function LabelInput({
  label,
  ...rest
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input
        {...rest}
        className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors"
      />
    </label>
  );
}
