"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";
import { Collapsible } from "./Collapsible";

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
  methodBEnabled: boolean;
  healthCheckEnabled: boolean;
  healthCheckCron: string;
  maxFollowerCount: number;
  maxFollowerCountTiktok: number;
  maxFollowingCount: number;
  requireNotPrivate: boolean;
};

// "Paramètres techniques" — 4 collapsed accordions. Non-dev user
// doesn't open these day-to-day, but everything they might need to
// tweak is still reachable.
export function PoolSettings({ initialConfig }: { initialConfig: Cfg }) {
  return (
    <div id="pool-settings" className="w-full scroll-mt-20">
      <div className="flex flex-col">
        <Collapsible
          label="AUTO-REFILL · SEUILS & CIBLES"
          hint="quand déclencher un scrape automatique"
          compact
        >
          <RefillBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="QUOTAS D'APPELS API"
          hint="plafonds RapidAPI par job"
          compact
        >
          <QuotasBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="VÉRIFICATION AUTOMATIQUE (CRON)"
          hint="planning du health-check quotidien"
          compact
        >
          <HealthCheckBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="CRITÈRES DE QUALITÉ DES COMPTES"
          hint="filtres au scrape + règles d'invalidation"
          compact
        >
          <QualificationBody initial={initialConfig} />
        </Collapsible>
      </div>
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
      {saving ? "[ SAUVEGARDE... ]" : "[ SAUVEGARDER ]"}
    </button>
  );
}

const INPUT_CLS =
  "interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";

function LabelInput({
  label,
  help,
  ...rest
}: {
  label: string;
  help?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      <input {...rest} className={INPUT_CLS} />
      {help && (
        <span className="font-mono text-[10px] text-[#666666] normal-case leading-snug">
          {help}
        </span>
      )}
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
      <span>{value ? "[ ACTIVÉ ]" : "[ DÉSACTIVÉ ]"}</span>
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
        toast.push("ok", "PARAMÈTRES SAUVEGARDÉS");
        router.refresh();
        return true;
      }
      toast.push("err", "ÉCHEC SAUVEGARDE");
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

// ── Accordion 01 — REFILL ────────────────────────────────────────────
function RefillBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [autoRefill, setAutoRefill] = useState(initial.autoRefillEnabled);
  const [thrIg, setThrIg] = useState(initial.refillThresholdInstagram);
  const [tgtIg, setTgtIg] = useState(initial.refillTargetInstagram);
  const [thrTt, setThrTt] = useState(initial.refillThresholdTiktok);
  const [tgtTt, setTgtTt] = useState(initial.refillTargetTiktok);

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Quand le nombre de comptes DISPO (par plateforme) passe sous le seuil,
        un scrape automatique se lance jusqu&apos;&agrave; atteindre la cible.
      </p>
      <ToggleRow
        label="AUTO-REFILL"
        value={autoRefill}
        onChange={setAutoRefill}
      />
      <div className="grid grid-cols-2 gap-3">
        <LabelInput
          label="SEUIL IG"
          help="Déclenche un scrape si DISPO < seuil."
          type="number"
          value={thrIg}
          onChange={(e) => setThrIg(Number(e.target.value) || 0)}
        />
        <LabelInput
          label="CIBLE IG"
          help="Stock DISPO à atteindre."
          type="number"
          value={tgtIg}
          onChange={(e) => setTgtIg(Number(e.target.value) || 0)}
        />
        <LabelInput
          label="SEUIL TT"
          help="Déclenche un scrape si DISPO < seuil."
          type="number"
          value={thrTt}
          onChange={(e) => setThrTt(Number(e.target.value) || 0)}
        />
        <LabelInput
          label="CIBLE TT"
          help="Stock DISPO à atteindre."
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
  );
}

// ── Accordion 02 — QUOTAS ───────────────────────────────────────────
function QuotasBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [scrapeCalls, setScrapeCalls] = useState(
    initial.maxRapidapiCallsPerScrapeRun
  );
  const [healthCalls, setHealthCalls] = useState(
    initial.maxRapidapiCallsPerHealthcheck
  );
  const [methodBAtt, setMethodBAtt] = useState(initial.maxAttemptsMethodB);
  const [pagesPerSeed, setPagesPerSeed] = useState(initial.maxPagesPerSeed);
  const [ratio, setRatio] = useState(initial.methodARatio);
  const methodB = initial.methodBEnabled;

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Plafonds pour limiter la facture RapidAPI. Baisse ces chiffres si tu
        vois la facture grimper.
      </p>
      <LabelInput
        label="MAX APPELS PAR SCRAPE"
        help="Nombre max. de requêtes RapidAPI par job de scrape."
        type="number"
        value={scrapeCalls}
        onChange={(e) => setScrapeCalls(Number(e.target.value) || 1)}
      />
      <LabelInput
        label="MAX APPELS PAR VÉRIFICATION"
        help="Nombre max. de requêtes RapidAPI par health-check."
        type="number"
        value={healthCalls}
        onChange={(e) => setHealthCalls(Number(e.target.value) || 1)}
      />
      <div className={`grid ${methodB ? "grid-cols-2" : "grid-cols-1"} gap-3`}>
        {methodB && (
          <LabelInput
            label="TENTATIVES MAX MÉTHODE 2"
            help="Nombre de usernames random testés avant d'arrêter la Phase B."
            type="number"
            value={methodBAtt}
            onChange={(e) => setMethodBAtt(Number(e.target.value) || 1)}
          />
        )}
        <LabelInput
          label="PAGES PAR SEED"
          help="Nombre de pages de followers lues par seed (Méthode A)."
          type="number"
          value={pagesPerSeed}
          onChange={(e) => setPagesPerSeed(Number(e.target.value) || 1)}
        />
      </div>
      {methodB && (
        <LabelInput
          label={`RATIO MÉTHODE A (0-1) — ACTUEL ${ratio}`}
          help="Proportion du scrape faite via les seeds (méthode A) vs random (B)."
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={ratio}
          onChange={(e) => setRatio(Number(e.target.value))}
        />
      )}
      {!methodB && (
        <p className="font-mono text-[10px] text-[#666666] normal-case leading-relaxed border-l-2 border-[#666666]/40 pl-3">
          La Méthode&nbsp;2 étant désactivée, les réglages associés (tentatives
          max, ratio A/B) sont masqués. Active-la dans la sous-section B pour y
          accéder.
        </p>
      )}
      <SaveButton
        saving={saving}
        onClick={() =>
          patch({
            maxRapidapiCallsPerScrapeRun: scrapeCalls,
            maxRapidapiCallsPerHealthcheck: healthCalls,
            ...(methodB ? { maxAttemptsMethodB: methodBAtt, methodARatio: ratio } : {}),
            maxPagesPerSeed: pagesPerSeed,
          })
        }
      />
    </div>
  );
}

// ── Accordion 03 — HEALTH CHECK ─────────────────────────────────────
function HealthCheckBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [enabled, setEnabled] = useState(initial.healthCheckEnabled);
  const [cron, setCron] = useState(initial.healthCheckCron);

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Le cron vérifie chaque jour que les comptes DISPO sont toujours
        vierges. Laisse activé en prod.
      </p>
      <ToggleRow
        label="VÉRIFICATION AUTO"
        value={enabled}
        onChange={setEnabled}
      />
      <LabelInput
        label="PLANNING (CRON)"
        help="Format min hour day month dow. Par défaut 03:00 UTC."
        type="text"
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        placeholder="0 3 * * *"
      />
      <SaveButton
        saving={saving}
        onClick={() =>
          patch({ healthCheckEnabled: enabled, healthCheckCron: cron })
        }
      />
    </div>
  );
}

// ── Accordion 04 — QUALIFICATION ────────────────────────────────────
function QualificationBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [maxFollowersIg, setMaxFollowersIg] = useState(initial.maxFollowerCount);
  const [maxFollowersTt, setMaxFollowersTt] = useState(
    initial.maxFollowerCountTiktok
  );
  const [maxFollowing, setMaxFollowing] = useState(initial.maxFollowingCount);
  const [requirePublic, setRequirePublic] = useState(initial.requireNotPrivate);

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Règles qui définissent ce qu&apos;est un &laquo;&nbsp;bon compte
        test&nbsp;&raquo;. Seuils <span className="text-white">séparés par
        plateforme</span> : Instagram est strict, TikTok plus tolérant. Chaque
        seuil sert à la fois au scrape (candidat rejeté s&apos;il dépasse) et
        à la vérification quotidienne (compte invalidé s&apos;il dépasse).
      </p>
      <LabelInput
        label="MAX ABONNÉS INSTAGRAM"
        help="Seuil strict : comptes vraiment inactifs."
        type="number"
        value={maxFollowersIg}
        onChange={(e) => setMaxFollowersIg(Number(e.target.value) || 0)}
      />
      <LabelInput
        label="MAX ABONNÉS TIKTOK"
        help="Seuil plus tolérant : TikTok a une dynamique virale naturelle, même les comptes dormants gagnent 5-30 followers."
        type="number"
        value={maxFollowersTt}
        onChange={(e) => setMaxFollowersTt(Number(e.target.value) || 0)}
      />
      <LabelInput
        label="MAX ABONNEMENTS"
        help="Un candidat qui suit trop de monde est rejeté au scrape."
        type="number"
        value={maxFollowing}
        onChange={(e) => setMaxFollowing(Number(e.target.value) || 0)}
      />
      <ToggleRow
        label="REFUSER COMPTES PRIVÉS"
        value={requirePublic}
        onChange={setRequirePublic}
      />
      <p className="font-mono text-[10px] text-[#666666] normal-case leading-relaxed">
        Note : la restriction sur le nombre de posts a été retirée — un compte
        peut avoir publié des posts et rester éligible.
      </p>
      <SaveButton
        saving={saving}
        onClick={() =>
          patch({
            maxFollowerCount: maxFollowersIg,
            maxFollowerCountTiktok: maxFollowersTt,
            maxFollowingCount: maxFollowing,
            requireNotPrivate: requirePublic,
          })
        }
      />
    </div>
  );
}
