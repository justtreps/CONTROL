"use client";

import { useEffect, useState } from "react";

type CadenceData = {
  pollIntervalMinutes: number;
  runningOrders: number;
  estimatedPollsPerHour: number;
  activeKeys: number;
  aggregateRpm: number;
  aggregateRph: number;
  saturation: number; // %
  verdict: "OK" | "AU LIMITE" | "DÉPASSEMENT";
};

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 720;

function verdictColor(v: CadenceData["verdict"] | string): string {
  if (v === "OK") return "#00CC66";
  if (v === "AU LIMITE") return "#FFCC00";
  return "#FF3300";
}

function verdictForSaturation(s: number): CadenceData["verdict"] {
  if (s < 70) return "OK";
  if (s < 95) return "AU LIMITE";
  return "DÉPASSEMENT";
}

export function PollCadenceCard() {
  const [data, setData] = useState<CadenceData | null>(null);
  const [draftMin, setDraftMin] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const res = await fetch("/api/system/poll-cadence", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const d = (await res.json()) as CadenceData;
        if (cancelled) return;
        setData(d);
        // Only seed the draft once so we don't overwrite the
        // operator's edit-in-progress on the next poll.
        setDraftMin((cur) => (cur === null ? d.pollIntervalMinutes : cur));
      } catch {
        /* ignore */
      }
    }
    fetchData();
    const id = setInterval(fetchData, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) {
    return (
      <div className="border border-[#666666]/30 p-6 md:p-8 bg-[#0D0D0D]">
        <h3 className="brand font-display text-2xl uppercase tracking-tight text-white mb-6">
          Cadence de polling
        </h3>
        <div className="font-mono text-xs text-[#666666] tracking-widest uppercase">
          CHARGEMENT…
        </div>
      </div>
    );
  }

  const dirty = draftMin !== null && draftMin !== data.pollIntervalMinutes;
  // Preview saturation for the draft value.
  const previewPolls =
    draftMin && draftMin > 0
      ? Math.round((data.runningOrders * 60) / draftMin)
      : 0;
  const previewSaturation =
    data.aggregateRph > 0 ? (previewPolls / data.aggregateRph) * 100 : 0;
  const previewVerdict = verdictForSaturation(previewSaturation);

  async function save() {
    if (draftMin === null) return;
    if (draftMin < MIN_INTERVAL || draftMin > MAX_INTERVAL) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/system/toggles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollIntervalMinutes: draftMin }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        restaggered?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setMsg(`✗ ÉCHEC : ${body.error ?? res.status}`);
      } else {
        setMsg(
          `✓ SAUVEGARDÉ — ${body.restaggered ?? 0} TestOrders restaggered`,
        );
      }
    } catch (e) {
      setMsg(`✗ ERREUR : ${(e as Error).message.slice(0, 80)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-[#666666]/30 p-6 md:p-8 bg-[#0D0D0D] flex flex-col gap-5">
      <h3 className="brand font-display text-2xl uppercase tracking-tight text-white">
        Cadence de polling
      </h3>

      {/* Live state */}
      <div className="grid grid-cols-2 gap-3 font-mono text-xs tracking-widest uppercase">
        <Row
          label="Cadence actuelle"
          value={`${data.pollIntervalMinutes} min`}
        />
        <Row
          label="TestOrders running"
          value={data.runningOrders.toLocaleString("en-US")}
        />
        <Row
          label="Polls/h estimés"
          value={data.estimatedPollsPerHour.toLocaleString("en-US")}
        />
        <Row
          label="Capacité RapidAPI"
          value={`${data.aggregateRph.toLocaleString("en-US")}/h (${data.activeKeys} keys)`}
        />
      </div>
      <div
        className="font-mono text-xs tracking-widest uppercase border px-3 py-2 w-max"
        style={{
          color: verdictColor(data.verdict),
          borderColor: verdictColor(data.verdict),
        }}
      >
        VERDICT : {data.verdict} ({data.saturation.toFixed(1)} %)
      </div>

      {/* Editor */}
      <div className="flex flex-col gap-3 border-t border-[#666666]/20 pt-5">
        <label className="font-mono text-xs text-[#666666] tracking-widest uppercase">
          Nouvelle cadence (min)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            value={draftMin ?? data.pollIntervalMinutes}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              setDraftMin(Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, v)));
              setMsg(null);
            }}
            className="interactive bg-transparent border border-[#666666]/30 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest text-white outline-none w-32"
          />
          <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            min — bornes {MIN_INTERVAL}-{MAX_INTERVAL}
          </span>
        </div>

        {/* Preview */}
        {dirty && (
          <div className="border border-[#FFCC00]/40 bg-[#0D0D0D] px-4 py-3 flex flex-col gap-2 font-mono text-xs tracking-widest uppercase">
            <span className="text-[#FFCC00]">[ APERÇU AVANT SAUVEGARDE ]</span>
            <div className="grid grid-cols-2 gap-2">
              <span className="text-[#666666]">
                Avant : {data.pollIntervalMinutes} min →{" "}
                {data.estimatedPollsPerHour}/h ({data.saturation.toFixed(1)} %)
              </span>
              <span className="text-white">
                Après : {draftMin} min → {previewPolls.toLocaleString("en-US")}/h
                ({previewSaturation.toFixed(1)} %)
              </span>
            </div>
            <span
              className="border px-2 py-1 w-max"
              style={{
                color: verdictColor(previewVerdict),
                borderColor: verdictColor(previewVerdict),
              }}
            >
              {previewVerdict === "DÉPASSEMENT"
                ? "⚠ DÉPASSEMENT — RapidAPI saturera"
                : `VERDICT : ${previewVerdict}`}
            </span>
          </div>
        )}

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#FF3300]"
          >
            {saving ? "…" : dirty ? "[ CONFIRMER ]" : "[ SAUVEGARDER ]"}
          </button>
          {msg && (
            <span
              className="font-mono text-xs tracking-widest uppercase"
              style={{
                color: msg.startsWith("✓") ? "#00CC66" : "#FF3300",
              }}
            >
              {msg}
            </span>
          )}
        </div>
      </div>

      <p className="font-mono text-[10px] text-[#666666] normal-case leading-relaxed">
        Sauvegarder restagger automatiquement les nextPollAt des TestOrders en
        cours sur la nouvelle fenêtre (avec jitter ±20 s pour éviter un
        thundering herd). Cadence par défaut 10 min — bumper si la flotte
        RapidAPI est limitée.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[#666666]">{label}</span>
      <span className="text-white tabular-nums">{value}</span>
    </div>
  );
}
