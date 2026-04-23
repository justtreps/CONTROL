"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";
import { Collapsible } from "./Collapsible";
import type { ActivePool } from "./PoolUniverseSwitch";

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
  engagementPoolEnabled: boolean;
  engagementPoolTargetInstagram: number;
  engagementPoolTargetTiktok: number;
  engagementPostsMin: number;
  engagementLikesMaxPerPost: number;
  engagementFreshnessMaxDays: number;
  servicesSyncFrequencyHours: number;
  lastServicesSyncAt: string | null;
  lastServicesSyncResult: Record<string, number> | null;
  servicesSyncStartedAt: string | null;
};

// "Paramètres techniques" — scoped to the active pool at the top.
// Each universe gets the one config body that matters for its flow
// (qualification rules for abonnés · engagement pool settings for
// engagement). Quotas and the cron schedule are shared across both
// pools so they stay below as always-shown sub-accordions.
//
// Auto-refill is deliberately NOT here — it's already the primary
// card in Zone 2 so surfacing it twice just invites inconsistent
// state.
export function PoolSettings({
  initialConfig,
  activePool,
}: {
  initialConfig: Cfg;
  activePool: ActivePool;
}) {
  return (
    <div id="pool-settings" className="w-full scroll-mt-20">
      <div className="flex flex-col">
        {activePool === "follower" ? (
          <Collapsible
            label="CRITÈRES DE QUALITÉ DES COMPTES"
            hint="filtres au scrape + règles d'invalidation · pool abonnés"
            compact
          >
            <QualificationBody initial={initialConfig} />
          </Collapsible>
        ) : (
          <Collapsible
            label="POOL ENGAGEMENT (LIKES / VUES / PARTAGES)"
            hint="toggle + targets + critères posts · pool engagement"
            compact
          >
            <EngagementBody initial={initialConfig} />
          </Collapsible>
        )}
        <Collapsible
          label="QUOTAS D'APPELS API"
          hint="plafonds RapidAPI par job · partagé"
          compact
        >
          <QuotasBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="VÉRIFICATION AUTOMATIQUE (CRON)"
          hint="planning du health-check quotidien · partagé"
          compact
        >
          <HealthCheckBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="SYNCHRONISATION SERVICES BULKMEDYA"
          hint="fréquence de la sync du catalogue · partagé"
          compact
        >
          <ServicesSyncBody initial={initialConfig} />
        </Collapsible>
        <Collapsible
          label="RATE LIMITER RAPIDAPI"
          hint="fenêtre live IG · partagé"
          compact
        >
          <RateLimiterBody />
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

// ── Accordion 05 — ENGAGEMENT POOL ─────────────────────────────────
function EngagementBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const [enabled, setEnabled] = useState(initial.engagementPoolEnabled);
  const [targetIg, setTargetIg] = useState(
    initial.engagementPoolTargetInstagram
  );
  const [targetTt, setTargetTt] = useState(initial.engagementPoolTargetTiktok);
  const [postsMin, setPostsMin] = useState(initial.engagementPostsMin);
  const [likesMax, setLikesMax] = useState(initial.engagementLikesMaxPerPost);
  const [freshness, setFreshness] = useState(
    initial.engagementFreshnessMaxDays
  );

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Pool secondaire pour tester les services de{" "}
        <span className="text-white">likes / vues / partages / enregistrements</span>
        . Les comptes de ce pool ont au moins {postsMin} post(s) récent(s)
        et des likes naturels bas. Désactivé par défaut — tant que le toggle
        n&apos;est pas activé, le scraper continue d&apos;utiliser
        uniquement le pool abonnés historique.
      </p>
      <ToggleRow
        label="POOL ENGAGEMENT ACTIVÉ"
        value={enabled}
        onChange={setEnabled}
      />
      <div className="grid grid-cols-2 gap-3">
        <LabelInput
          label="CIBLE IG ENGAGEMENT"
          help="Nombre de comptes engagement à maintenir pour Instagram."
          type="number"
          value={targetIg}
          onChange={(e) => setTargetIg(Number(e.target.value) || 0)}
        />
        <LabelInput
          label="CIBLE TT ENGAGEMENT"
          help="Nombre de comptes engagement à maintenir pour TikTok."
          type="number"
          value={targetTt}
          onChange={(e) => setTargetTt(Number(e.target.value) || 0)}
        />
      </div>
      <LabelInput
        label="POSTS MIN PAR COMPTE"
        help="Un candidat doit avoir au moins N posts pour qualifier."
        type="number"
        value={postsMin}
        onChange={(e) => setPostsMin(Number(e.target.value) || 0)}
      />
      <LabelInput
        label="MAX LIKES NATURELS PAR POST"
        help="Un post avec plus de N likes a une baseline trop élevée — rejeté."
        type="number"
        value={likesMax}
        onChange={(e) => setLikesMax(Number(e.target.value) || 0)}
      />
      <LabelInput
        label="ANCIENNETÉ MAX DES POSTS (JOURS)"
        help="Post plus ancien que N jours = obsolète, rejeté au scrape. BulkMedya livre mieux sur posts récents — 30 jours par défaut."
        type="number"
        value={freshness}
        onChange={(e) => setFreshness(Number(e.target.value) || 0)}
      />
      <SaveButton
        saving={saving}
        onClick={() =>
          patch({
            engagementPoolEnabled: enabled,
            engagementPoolTargetInstagram: targetIg,
            engagementPoolTargetTiktok: targetTt,
            engagementPostsMin: postsMin,
            engagementLikesMaxPerPost: likesMax,
            engagementFreshnessMaxDays: freshness,
          })
        }
      />
    </div>
  );
}

// ── Accordion — SERVICES SYNC (frequency + last-run readout + manual trigger) ───────
function ServicesSyncBody({ initial }: { initial: Cfg }) {
  const { patch, saving } = usePatchConfig();
  const toast = usePoolToast();
  const router = useRouter();
  const [freq, setFreq] = useState(initial.servicesSyncFrequencyHours ?? 1);

  // SSR-driven readout. router.refresh() from the polling effect
  // repaints these via new props — we don't keep local shadow state
  // beyond the "watching" flag below so the UI always reflects the
  // actual DB.
  const lastRun = initial.lastServicesSyncAt
    ? formatRelative(initial.lastServicesSyncAt)
    : null;
  const r = initial.lastServicesSyncResult ?? null;

  // Server-side "run in progress" — ultimately the single source of
  // truth. inProgressServer=true means the DB lock is held; false
  // means the worker has released it (success, error, or stale>10m
  // auto-clear). The button's enabled state is driven by this alone
  // so the UI can never get stuck on client-only flags.
  const inProgressServer = Boolean(initial.servicesSyncStartedAt);

  // "watching" = we want to poll for completion + pop a toast.
  // Independent from button state — exists only to drive the
  // router.refresh() loop and the completion toast.
  const [watching, setWatching] = useState(false);
  const watchRef = useRef<string | null>(null);

  // Polling: every 10s while watching, router.refresh() to pull new
  // SSR props. Stops the moment the server lock clears OR a new
  // lastServicesSyncAt lands (whichever comes first).
  useEffect(() => {
    if (!watching) return;
    const id = setInterval(() => {
      router.refresh();
    }, 10_000);
    const timeout = setTimeout(
      () => {
        setWatching(false);
        toast.push(
          "err",
          "SYNC : AUCUNE RÉPONSE APRÈS 6 MIN — VÉRIFIE VERCEL LOGS"
        );
      },
      6 * 60_000
    );
    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
  }, [watching, router, toast]);

  // Completion detection — primary signal: server lock cleared.
  // Secondary: lastServicesSyncAt shifted vs our click-time snapshot.
  // Either signal exits watch mode so a race condition (prop update
  // ordering) can't leave the UI stuck.
  useEffect(() => {
    if (!watching) return;
    const lockCleared = !inProgressServer;
    const timestampShifted =
      initial.lastServicesSyncAt &&
      initial.lastServicesSyncAt !== watchRef.current;
    if (!lockCleared && !timestampShifted) return;

    setWatching(false);
    const data = initial.lastServicesSyncResult;
    if (timestampShifted && data) {
      const c = Number(data.created ?? 0);
      const u = Number(data.updated ?? 0);
      const d = Number(data.deactivated ?? 0);
      toast.push(
        "ok",
        `SYNC OK · +${c} CRÉÉS · ${u} UPDATED · ${d} DEACTIVATED`
      );
    } else if (lockCleared) {
      // Lock cleared but no new result — likely already-completed
      // when we started watching. Silent exit (don't spam toasts).
    }
  }, [
    inProgressServer,
    initial.lastServicesSyncAt,
    initial.lastServicesSyncResult,
    watching,
    toast,
  ]);

  async function runManualSync() {
    if (inProgressServer) return;
    watchRef.current = initial.lastServicesSyncAt;
    try {
      const res = await fetch("/api/config/sync-services", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.push("err", `ÉCHEC DISPATCH: ${data.error ?? "unknown"}`);
        return;
      }
      if (data.skipped === "already_running") {
        toast.push(
          "err",
          "SYNC DÉJÀ EN COURS — ATTENDS LA FIN AVANT DE RECLIQUER"
        );
        setWatching(true);
        return;
      }
      toast.push("ok", "SYNC LANCÉ EN ARRIÈRE-PLAN");
      setWatching(true);
      router.refresh();
    } catch (e) {
      toast.push("err", `ERREUR RÉSEAU: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  // Button disable is driven by SERVER state only — inProgressServer
  // is Boolean(initial.servicesSyncStartedAt). Client-only flags no
  // longer gate the click so the UI can't desync from the DB truth.
  const buttonDisabled = inProgressServer;
  const buttonLabel = inProgressServer
    ? "[ SYNC EN COURS... ]"
    : watching
      ? "[ SYNC MAINTENANT ]" // watching but lock cleared — ready again
      : "[ SYNC MAINTENANT ]";

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-4">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Le cron Vercel se déclenche chaque heure. Cette fréquence contrôle
        si le run effectif a lieu ou s&apos;il est <em>skipped</em>. Ex:
        valeur 6h = 1 sync tous les 6h même si le cron fire toutes les
        heures.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:items-end">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            FRÉQUENCE SYNC SERVICES (HEURES)
          </span>
          <select
            value={freq}
            onChange={(e) => setFreq(Number(e.target.value))}
            className={INPUT_CLS}
          >
            <option value={1}>1H — chaque heure</option>
            <option value={3}>3H</option>
            <option value={6}>6H</option>
            <option value={12}>12H</option>
            <option value={24}>24H — une fois par jour</option>
          </select>
        </label>
        <button
          type="button"
          onClick={runManualSync}
          disabled={buttonDisabled}
          className={`interactive border px-5 py-2 font-mono text-xs tracking-widest uppercase transition-colors whitespace-nowrap ${
            buttonDisabled
              ? "border-[#666666]/40 text-[#666666] cursor-wait"
              : "border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black"
          }`}
          title={
            buttonDisabled
              ? "Un sync est déjà en cours — attend la fin"
              : "Ignore la fréquence et lance un sync tout de suite (en arrière-plan)"
          }
        >
          {buttonLabel}
        </button>
      </div>

      <div className="flex flex-col gap-2 pt-3 border-t border-[#666666]/20 font-mono text-[11px] tracking-widest uppercase">
        <div className="flex items-center justify-between">
          <span className="text-[#666666]">DERNIER RUN</span>
          <span className={lastRun ? "text-white" : "text-[#666666]"}>
            {lastRun ?? "— jamais"}
          </span>
        </div>
        {r && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[#666666]">FETCHED / KEPT</span>
              <span className="text-white tabular-nums">
                {(r.total ?? 0).toLocaleString("en-US")} /{" "}
                {((r.created ?? 0) + (r.updated ?? 0)).toLocaleString("en-US")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#666666]">CREATED · UPDATED</span>
              <span className="text-[#FF3300] tabular-nums">
                +{(r.created ?? 0).toLocaleString("en-US")}
                <span className="text-[#666666]"> · </span>
                {(r.updated ?? 0).toLocaleString("en-US")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#666666]">DEACTIVATED · SKIPPED</span>
              <span className="text-[#666666] tabular-nums">
                {(r.deactivated ?? 0).toLocaleString("en-US")}
                <span> · </span>
                {(r.skippedOutOfScope ?? 0).toLocaleString("en-US")}
              </span>
            </div>
          </>
        )}
      </div>

      <SaveButton
        saving={saving}
        onClick={() =>
          patch({
            servicesSyncFrequencyHours: freq as 1 | 3 | 6 | 12 | 24,
          })
        }
      />
    </div>
  );
}

// Same helper shape as the Hero's formatRelative — duplicated inline
// to avoid cross-file state coupling in this client component.
function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "JUST NOW";
  if (min < 60) return `${min}M AGO`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}H AGO`;
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}

// ── Accordion — RATE LIMITER LIVE SNAPSHOT ─────────────────────────
// Polls /api/pool/debug/rate-limiter every 5s and renders the
// in-flight window count vs the 85 req/min cap. Shared across both
// universes (the limiter itself is global).
type RateLimiterSnapshot = {
  backend: "upstash" | "in-memory";
  inFlightWindowSize: number;
  maxPerWindow: number;
  error?: string;
};

function RateLimiterBody() {
  const [snap, setSnap] = useState<RateLimiterSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/pool/debug/rate-limiter", {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as RateLimiterSnapshot;
        if (!cancelled) {
          setSnap(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message.slice(0, 80));
      }
    }
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const max = snap?.maxPerWindow ?? 85;
  const count = snap?.inFlightWindowSize ?? 0;
  const backend = snap?.backend;

  // Status bucket — OK under 60, CHARGE at 60-79, SATURÉ at 80+.
  const status =
    count < 60 ? "OK" : count < 80 ? "CHARGE" : "SATURÉ";
  const statusColor =
    status === "OK"
      ? "#00CC66"
      : status === "CHARGE"
        ? "#FFCC00"
        : "#FF3300";

  // Progress bar fill — proportion of the cap currently consumed.
  const fillPct = Math.min(100, Math.round((count / max) * 100));

  return (
    <div className="p-5 md:p-6 bg-[#030303] flex flex-col gap-5">
      <p className="font-mono text-[11px] text-[#666666] normal-case leading-relaxed">
        Fenêtre glissante de 60 secondes sur les appels RapidAPI
        Instagram. Plafond 85/min (marge 15% sous la limite MEGA
        100/min). Shared entre tous les workers Vercel quand le
        backend Upstash est actif — sinon per-process in-memory.
      </p>

      {/* BACKEND badge */}
      <div className="flex items-center justify-between border-b border-[#666666]/20 pb-4">
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          BACKEND
        </span>
        {backend === "upstash" ? (
          <span
            className="font-mono text-[11px] tracking-widest uppercase border px-3 py-1"
            style={{ color: "#00CC66", borderColor: "#00CC66" }}
          >
            [ UPSTASH ]
          </span>
        ) : backend === "in-memory" ? (
          <span
            className="font-mono text-[11px] tracking-widest uppercase border px-3 py-1"
            style={{ color: "#FFCC00", borderColor: "#FFCC00" }}
          >
            [ IN-MEMORY ]
          </span>
        ) : (
          <span className="font-mono text-[11px] tracking-widest uppercase border border-[#666666]/40 text-[#666666] px-3 py-1">
            [ ... ]
          </span>
        )}
      </div>

      {/* FENÊTRE COURANTE — big number */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          FENÊTRE COURANTE (60s)
        </span>
        <div className="flex items-baseline justify-between">
          <span
            className="brand font-display tracking-tight leading-none tabular-nums text-white"
            style={{ fontSize: "clamp(2.5rem, 6vw, 4.5rem)" }}
          >
            {count}
            <span className="text-[#666666]">
              {" "}
              / {max}
            </span>
          </span>
          <span className="font-mono text-[11px] text-[#666666] tracking-widest uppercase tabular-nums">
            {fillPct}%
          </span>
        </div>
        <div className="w-full h-[3px] bg-[#666666]/20 overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${fillPct}%`,
              backgroundColor: statusColor,
            }}
          />
        </div>
      </div>

      {/* STATUT badge */}
      <div className="flex items-center justify-between pt-2">
        <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
          STATUT
        </span>
        <span
          className="font-mono text-[11px] tracking-widest uppercase border px-3 py-1"
          style={{ color: statusColor, borderColor: statusColor }}
        >
          [ {status} ]
        </span>
      </div>

      {(error || snap?.error) && (
        <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase normal-case border border-[#FF3300]/40 px-3 py-2 break-words">
          {error ? `ERREUR POLL : ${error}` : snap?.error}
        </div>
      )}

      <div className="font-mono text-[10px] text-[#666666]/60 tracking-widest uppercase">
        AUTO-REFRESH · 5S
      </div>
    </div>
  );
}
