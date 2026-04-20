"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";

type Cfg = {
  autoRefillEnabled: boolean;
  refillThresholdInstagram: number;
  refillTargetInstagram: number;
  refillThresholdTiktok: number;
  refillTargetTiktok: number;
  maxRapidapiCallsPerScrapeRun: number;
  maxRapidapiCallsPerHealthcheck: number;
  maxAttemptsMethodB: number;
  maxPagesPerSeed: number;
  methodARatio: number;
  healthCheckEnabled: boolean;
  healthCheckCron: string;
  maxFollowerCount: number;
  maxFollowingCount: number;
  requireNotPrivate: boolean;
  invalidateIfFollowerAbove: number;
};

export function PoolSettings({ initialConfig }: { initialConfig: Cfg }) {
  return (
    <section id="pool-settings" className="w-full scroll-mt-20">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
        [ PARAMÈTRES ]
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 w-full border-b border-[#666666]/20">
        <RefillCard initial={initialConfig} />
        <QuotasCard initial={initialConfig} />
        <HealthCheckCard initial={initialConfig} />
        <QualificationCard initial={initialConfig} />
      </div>
    </section>
  );
}

// ── Shared card shell ────────────────────────────────────────────────
function CardShell({
  num,
  title,
  children,
  bg = "bg-[#030303]",
  borderRight = false,
  borderBottom = false,
}: {
  num: string;
  title: string;
  children: React.ReactNode;
  bg?: string;
  borderRight?: boolean;
  borderBottom?: boolean;
}) {
  return (
    <div
      className={`relative p-6 md:p-8 ${bg} ${
        borderRight ? "md:border-r border-[#666666]/20" : ""
      } ${borderBottom ? "border-b border-[#666666]/20" : ""}`}
    >
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-xs text-[#FF3300] tracking-widest">
          {num}
        </span>
      </div>
      <h3 className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white mb-6">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SaveButton({
  saving,
  onClick,
}: {
  saving: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="interactive mt-4 border border-white bg-white text-black py-2 px-6 font-mono text-xs tracking-widest uppercase hover:bg-[#FF3300] hover:border-[#FF3300] transition-colors disabled:opacity-60"
    >
      {saving ? "[ SAUVEGARDE... ]" : "[ SAVE ]"}
    </button>
  );
}

const INPUT_CLS =
  "interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";

function LabelInput({
  label,
  ...rest
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input {...rest} className={INPUT_CLS} />
    </label>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`interactive w-full border py-2 px-3 flex items-center justify-between font-mono text-[11px] tracking-widest uppercase transition-colors ${
        value
          ? "bg-[#FF3300] border-[#FF3300] text-black"
          : "border-[#666666]/40 text-[#666666] hover:border-white hover:text-white"
      }`}
    >
      <span>{label}</span>
      <span>{value ? "[ ENABLED ]" : "[ DISABLED ]"}</span>
    </button>
  );
}

// ── Shared PATCH helper ──────────────────────────────────────────────
function usePatchConfig() {
  const router = useRouter();
  const toast = usePoolToast();
  const [saving, setSaving] = useState(false);

  async function patch(patchBody: Partial<Cfg>) {
    if (saving) return false;
    setSaving(true);
    try {
      const res = await fetch("/api/pool/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (res.ok) {
        toast.push("ok", "CONFIG UPDATED");
        router.refresh();
        return true;
      }
      toast.push("err", "SAVE FAILED");
      return false;
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { patch, saving };
}

// ── Card 01 — REFILL ────────────────────────────────────────────────
function RefillCard({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [autoRefill, setAutoRefill] = useState(initial.autoRefillEnabled);
  const [thrIg, setThrIg] = useState(initial.refillThresholdInstagram);
  const [tgtIg, setTgtIg] = useState(initial.refillTargetInstagram);
  const [thrTt, setThrTt] = useState(initial.refillThresholdTiktok);
  const [tgtTt, setTgtTt] = useState(initial.refillTargetTiktok);

  return (
    <CardShell num="01" title="Refill" bg="bg-[#030303]" borderRight borderBottom>
      <div className="flex flex-col gap-4">
        <ToggleRow
          label="AUTO-REFILL"
          value={autoRefill}
          onChange={setAutoRefill}
        />
        <div className="grid grid-cols-2 gap-3">
          <LabelInput
            label="IG THRESHOLD"
            type="number"
            value={thrIg}
            onChange={(e) => setThrIg(Number(e.target.value) || 0)}
          />
          <LabelInput
            label="IG TARGET"
            type="number"
            value={tgtIg}
            onChange={(e) => setTgtIg(Number(e.target.value) || 0)}
          />
          <LabelInput
            label="TT THRESHOLD"
            type="number"
            value={thrTt}
            onChange={(e) => setThrTt(Number(e.target.value) || 0)}
          />
          <LabelInput
            label="TT TARGET"
            type="number"
            value={tgtTt}
            onChange={(e) => setTgtTt(Number(e.target.value) || 0)}
          />
        </div>
        <SaveButton
          saving={saving}
          onClick={() =>
            patch({
              autoRefillEnabled: autoRefill,
              refillThresholdInstagram: thrIg,
              refillTargetInstagram: tgtIg,
              refillThresholdTiktok: thrTt,
              refillTargetTiktok: tgtTt,
            })
          }
        />
      </div>
    </CardShell>
  );
}

// ── Card 02 — QUOTAS ────────────────────────────────────────────────
function QuotasCard({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [scrapeCalls, setScrapeCalls] = useState(initial.maxRapidapiCallsPerScrapeRun);
  const [healthCalls, setHealthCalls] = useState(initial.maxRapidapiCallsPerHealthcheck);
  const [methodBAtt, setMethodBAtt] = useState(initial.maxAttemptsMethodB);
  const [pagesPerSeed, setPagesPerSeed] = useState(initial.maxPagesPerSeed);
  const [ratio, setRatio] = useState(initial.methodARatio);

  return (
    <CardShell num="02" title="Quotas" bg="bg-[#0D0D0D]" borderBottom>
      <div className="flex flex-col gap-4">
        <LabelInput
          label="MAX CALLS / SCRAPE RUN"
          type="number"
          value={scrapeCalls}
          onChange={(e) => setScrapeCalls(Number(e.target.value) || 1)}
        />
        <LabelInput
          label="MAX CALLS / HEALTHCHECK"
          type="number"
          value={healthCalls}
          onChange={(e) => setHealthCalls(Number(e.target.value) || 1)}
        />
        <div className="grid grid-cols-2 gap-3">
          <LabelInput
            label="METHOD B ATTEMPTS"
            type="number"
            value={methodBAtt}
            onChange={(e) => setMethodBAtt(Number(e.target.value) || 1)}
          />
          <LabelInput
            label="PAGES / SEED"
            type="number"
            value={pagesPerSeed}
            onChange={(e) => setPagesPerSeed(Number(e.target.value) || 1)}
          />
        </div>
        <LabelInput
          label={`METHOD A RATIO (0-1) — CURRENT ${ratio}`}
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={ratio}
          onChange={(e) => setRatio(Number(e.target.value))}
        />
        <SaveButton
          saving={saving}
          onClick={() =>
            patch({
              maxRapidapiCallsPerScrapeRun: scrapeCalls,
              maxRapidapiCallsPerHealthcheck: healthCalls,
              maxAttemptsMethodB: methodBAtt,
              maxPagesPerSeed: pagesPerSeed,
              methodARatio: ratio,
            })
          }
        />
      </div>
    </CardShell>
  );
}

// ── Card 03 — HEALTH CHECK ──────────────────────────────────────────
function HealthCheckCard({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [enabled, setEnabled] = useState(initial.healthCheckEnabled);
  const [cron, setCron] = useState(initial.healthCheckCron);

  return (
    <CardShell num="03" title="Health Check" bg="bg-[#0D0D0D]" borderRight>
      <div className="flex flex-col gap-4">
        <ToggleRow label="HEALTH CHECK" value={enabled} onChange={setEnabled} />
        <LabelInput
          label="CRON EXPRESSION"
          type="text"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 3 * * *"
        />
        <p className="font-mono text-[10px] text-[#666666] tracking-widest uppercase leading-relaxed">
          DEFAULT: 03:00 UTC DAILY. FORMAT MIN HOUR DAY MONTH DOW.
        </p>
        <SaveButton
          saving={saving}
          onClick={() =>
            patch({ healthCheckEnabled: enabled, healthCheckCron: cron })
          }
        />
      </div>
    </CardShell>
  );
}

// ── Card 04 — QUALIFICATION & INVALIDATION ──────────────────────────
function QualificationCard({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [maxFollowers, setMaxFollowers] = useState(initial.maxFollowerCount);
  const [maxFollowing, setMaxFollowing] = useState(initial.maxFollowingCount);
  const [requirePublic, setRequirePublic] = useState(initial.requireNotPrivate);
  const [invalidateAbove, setInvalidateAbove] = useState(
    initial.invalidateIfFollowerAbove
  );

  return (
    <CardShell num="04" title="Qualification" bg="bg-[#030303]">
      <div className="flex flex-col gap-4">
        <LabelInput
          label="MAX FOLLOWER COUNT (SCRAPE)"
          type="number"
          value={maxFollowers}
          onChange={(e) => setMaxFollowers(Number(e.target.value) || 0)}
        />
        <LabelInput
          label="MAX FOLLOWING COUNT (SCRAPE)"
          type="number"
          value={maxFollowing}
          onChange={(e) => setMaxFollowing(Number(e.target.value) || 0)}
        />
        <ToggleRow
          label="REQUIRE PUBLIC"
          value={requirePublic}
          onChange={setRequirePublic}
        />
        <LabelInput
          label="INVALIDATE IF FOLLOWERS > (HEALTH)"
          type="number"
          value={invalidateAbove}
          onChange={(e) => setInvalidateAbove(Number(e.target.value) || 0)}
        />
        <p className="font-mono text-[10px] text-[#666666] tracking-widest uppercase leading-relaxed">
          MEDIA COUNT RESTRICTION REMOVED — POSTS ALLOWED.
        </p>
        <SaveButton
          saving={saving}
          onClick={() =>
            patch({
              maxFollowerCount: maxFollowers,
              maxFollowingCount: maxFollowing,
              requireNotPrivate: requirePublic,
              invalidateIfFollowerAbove: invalidateAbove,
            })
          }
        />
      </div>
    </CardShell>
  );
}
