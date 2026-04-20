"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { usePoolToast } from "./PoolToast";

type Props = {
  initialConfig: {
    autoRefillEnabled: boolean;
    refillThresholdInstagram: number;
    refillTargetInstagram: number;
    refillThresholdTiktok: number;
    refillTargetTiktok: number;
  };
};

// Section 3 — Pattern D three-card manual controls.
//   Card 01  SCRAPE
//   Card 02  HEALTH CHECK
//   Card 03  AUTO-REFILL toggle + thresholds
export function PoolControls({ initialConfig }: Props) {
  const router = useRouter();
  const { show, hide } = useLoading();
  const toast = usePoolToast();

  const [scrapePlatform, setScrapePlatform] = useState<"instagram" | "tiktok" | "both">("both");
  const [scrapeCount, setScrapeCount] = useState(1000);
  const [scrapeRunning, setScrapeRunning] = useState(false);

  const [healthPlatform, setHealthPlatform] = useState<"instagram" | "tiktok" | "both">("both");
  const [healthRunning, setHealthRunning] = useState(false);

  const [autoRefill, setAutoRefill] = useState(initialConfig.autoRefillEnabled);
  const [savingAutoRefill, setSavingAutoRefill] = useState(false);

  async function runScrape() {
    if (scrapeRunning) return;
    setScrapeRunning(true);
    show();
    try {
      const res = await fetch("/api/pool/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: scrapePlatform, count: scrapeCount }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.push("ok", `SCRAPE JOB #${data.jobId} QUEUED`);
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

  async function runHealthCheck() {
    if (healthRunning) return;
    setHealthRunning(true);
    show();
    try {
      const res = await fetch("/api/pool/health-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: healthPlatform }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.push("ok", `HEALTH CHECK #${data.jobId} QUEUED`);
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
        toast.push("ok", `AUTO-REFILL ${next ? "ENABLED" : "DISABLED"}`);
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

  function scrollToSettings() {
    document
      .getElementById("pool-settings")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
        [ CONTRÔLES MANUELS ]
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 w-full border-b border-[#666666]/20">
        {/* Card 01 — SCRAPE */}
        <div className="relative p-6 md:p-12 bg-[#030303] md:border-r border-[#666666]/20">
          <CardHeader num="01" icon="solar:download-linear" />
          <CardTitle>Scrape</CardTitle>
          <div className="flex flex-col gap-4">
            <LabelSelect
              label="PLATEFORME"
              value={scrapePlatform}
              onChange={(v) => setScrapePlatform(v as typeof scrapePlatform)}
              options={[
                { value: "both", label: "INSTAGRAM + TIKTOK" },
                { value: "instagram", label: "INSTAGRAM" },
                { value: "tiktok", label: "TIKTOK" },
              ]}
            />
            <LabelInput
              label="TARGET COUNT"
              type="number"
              min={1}
              max={10000}
              value={scrapeCount}
              onChange={(e) =>
                setScrapeCount(Math.max(1, Number(e.target.value) || 1000))
              }
            />
            <button
              type="button"
              onClick={runScrape}
              disabled={scrapeRunning}
              className="interactive group relative w-full border border-[#FF3300] bg-[#FF3300] text-black py-4 px-6 overflow-hidden flex justify-between items-center text-left disabled:opacity-60 mt-2"
            >
              <span className="relative font-mono text-xs tracking-widest z-10">
                {scrapeRunning ? "[ QUEUEING... ]" : "[ RUN SCRAPE ]"}
              </span>
              <span className="font-mono text-xs z-10">→</span>
            </button>
          </div>
        </div>

        {/* Card 02 — HEALTH CHECK */}
        <div className="relative p-6 md:p-12 bg-[#0D0D0D] md:border-r border-[#666666]/20">
          <CardHeader num="02" icon="solar:pulse-linear" />
          <CardTitle>Health Check</CardTitle>
          <div className="flex flex-col gap-4">
            <LabelSelect
              label="PLATEFORME"
              value={healthPlatform}
              onChange={(v) => setHealthPlatform(v as typeof healthPlatform)}
              options={[
                { value: "both", label: "INSTAGRAM + TIKTOK" },
                { value: "instagram", label: "INSTAGRAM" },
                { value: "tiktok", label: "TIKTOK" },
              ]}
            />
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase leading-relaxed">
              VÉRIFIE QUE CHAQUE COMPTE EST TOUJOURS VIERGE. INVALIDE CEUX QUI
              ONT DÉPASSÉ LES SEUILS.
            </p>
            <button
              type="button"
              onClick={runHealthCheck}
              disabled={healthRunning}
              className="interactive group relative w-full border border-[#666666]/40 bg-transparent text-white py-4 px-6 overflow-hidden flex justify-between items-center text-left disabled:opacity-60 mt-2 hover:border-white transition-colors"
            >
              <span className="relative font-mono text-xs tracking-widest z-10">
                {healthRunning ? "[ QUEUEING... ]" : "[ RUN HEALTH CHECK ]"}
              </span>
              <span className="font-mono text-xs z-10">→</span>
            </button>
          </div>
        </div>

        {/* Card 03 — AUTO-REFILL */}
        <div className="relative p-6 md:p-12 bg-[#030303]">
          <CardHeader num="03" icon="solar:refresh-linear" />
          <CardTitle>Auto-refill</CardTitle>
          <div className="flex flex-col gap-4">
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
              <span>{autoRefill ? "[ ENABLED ]" : "[ DISABLED ]"}</span>
            </button>

            <div className="flex flex-col gap-2 font-mono text-xs tracking-widest uppercase pt-2 border-t border-[#666666]/20">
              <ThresholdRow
                label="IG"
                threshold={initialConfig.refillThresholdInstagram}
                target={initialConfig.refillTargetInstagram}
              />
              <ThresholdRow
                label="TT"
                threshold={initialConfig.refillThresholdTiktok}
                target={initialConfig.refillTargetTiktok}
              />
            </div>

            <button
              type="button"
              onClick={scrollToSettings}
              className="interactive font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white transition-colors text-left"
            >
              [ ÉDITER PARAMÈTRES ↓ ]
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CardHeader({ num, icon }: { num: string; icon: string }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <span className="font-mono text-xs text-[#FF3300] tracking-widest">
        {num}
      </span>
      <iconify-icon
        icon={icon}
        width="20"
        height="20"
        style={{ color: "#666666" }}
      />
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="brand font-display text-2xl md:text-3xl uppercase tracking-tight text-white mb-6">
      {children}
    </h3>
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
    <label className="flex flex-col gap-2">
      <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
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
    <label className="flex flex-col gap-2">
      <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input
        {...rest}
        className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors"
      />
    </label>
  );
}

function ThresholdRow({
  label,
  threshold,
  target,
}: {
  label: string;
  threshold: number;
  target: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#666666]">{label}</span>
      <span className="text-white tabular-nums">
        {threshold.toLocaleString("en-US")} / {target.toLocaleString("en-US")}
      </span>
    </div>
  );
}
