"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type KeyRow = {
  id: number;
  provider: string;
  label: string;
  status: "active" | "capped" | "disabled" | string;
  quotaMonthly: number | null;
  quotaUsed: number;
  resetDayOfMonth: number | null;
  rateLimitPerMin: number | null;
  lastCappedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = { rows: KeyRow[] };

const STATUS_COLOR: Record<string, string> = {
  active: "#00CC66",
  capped: "#FF3300",
  disabled: "#666666",
};

export function RapidApiKeysCard() {
  const router = useRouter();
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [showDocs, setShowDocs] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/config/rapidapi-keys", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as ListResponse;
      setRows(data.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Live refresh so operator sees the quotaUsed counter climb while
    // jobs run. 10s matches the UI poll cadence the user spec'd.
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function patch(id: number, body: Record<string, unknown>) {
    setBusy((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/config/rapidapi-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await refresh();
        router.refresh();
      }
    } finally {
      setBusy((s) => ({ ...s, [id]: false }));
    }
  }

  async function remove(id: number) {
    if (!confirm("Supprimer cette clé ? Les jobs en cours qui l'utilisaient basculeront sur une autre clé active."))
      return;
    setBusy((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/config/rapidapi-keys/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await refresh();
        router.refresh();
      }
    } finally {
      setBusy((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <section className="px-4 md:px-8 py-16 md:py-20 border-t border-[#666666]/20">
      <div className="max-w-7xl mx-auto flex flex-col gap-6">
        <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
          [ FLOTTE RAPIDAPI · MULTI-CLÉS ]
        </div>
        <div className="flex items-end justify-between gap-4 flex-wrap border-b border-[#FF3300]/60 pb-3">
          <div className="flex items-end gap-4 flex-wrap">
            <h2
              className="brand font-display uppercase tracking-tight text-white m-0 leading-none"
              style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
            >
              Flotte <span className="text-[#FF3300]">RapidAPI.</span>
            </h2>
            <span className="font-mono text-[10px] text-[#666666] tracking-wide normal-case">
              round-robin · failover auto · quota live
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase"
          >
            [ + AJOUTER UNE CLÉ ]
          </button>
        </div>

        <div className="border border-[#666666]/30 overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
              <tr className="border-b border-[#666666]/20">
                <th className="text-left px-4 py-3 font-normal">Label</th>
                <th className="text-left px-3 py-3 font-normal">Provider</th>
                <th className="text-left px-3 py-3 font-normal">Statut</th>
                <th className="text-left px-3 py-3 font-normal">Quota</th>
                <th className="text-left px-3 py-3 font-normal">Prochain reset</th>
                <th className="text-left px-3 py-3 font-normal hidden md:table-cell">
                  Rate/min
                </th>
                <th className="text-right px-3 py-3 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 font-mono text-xs text-[#666666] tracking-widest uppercase text-center"
                  >
                    CHARGEMENT...
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 font-mono text-xs text-[#666666] tracking-widest uppercase text-center"
                  >
                    AUCUNE CLÉ CONFIGURÉE — AJOUTES-EN UNE POUR COMMENCER
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <KeyRowView
                  key={r.id}
                  row={r}
                  busy={Boolean(busy[r.id])}
                  onDisable={() => patch(r.id, { status: "disabled" })}
                  onEnable={() => patch(r.id, { status: "active" })}
                  onDelete={() => remove(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Documentation accordion */}
        <button
          type="button"
          onClick={() => setShowDocs((v) => !v)}
          className="interactive text-left border border-[#666666]/30 hover:border-white transition-colors px-5 py-3 font-mono text-xs tracking-widest uppercase flex items-center justify-between"
        >
          <span>[ COMMENT ÇA MARCHE ]</span>
          <span className="text-[#666666]">{showDocs ? "▲" : "▼"}</span>
        </button>
        {showDocs && <DocsBody />}
      </div>

      {showAddModal && (
        <AddKeyModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => {
            setShowAddModal(false);
            refresh();
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function KeyRowView({
  row,
  busy,
  onDisable,
  onEnable,
  onDelete,
}: {
  row: KeyRow;
  busy: boolean;
  onDisable: () => void;
  onEnable: () => void;
  onDelete: () => void;
}) {
  const pct =
    row.quotaMonthly && row.quotaMonthly > 0
      ? Math.min(100, Math.round((row.quotaUsed / row.quotaMonthly) * 100))
      : null;
  // Visual bucket colour — mirrors the rate-limiter status badge but
  // on monthly quota.
  const quotaColor =
    row.status === "disabled"
      ? "#666666"
      : row.status === "capped"
        ? "#FF3300"
        : pct === null
          ? "#FFFFFF"
          : pct >= 90
            ? "#FF3300"
            : pct >= 70
              ? "#FFCC00"
              : "#00CC66";
  const statusColor = STATUS_COLOR[row.status] ?? "#FFFFFF";

  const daysToReset = resetCountdownDays(row.resetDayOfMonth);

  return (
    <tr className="border-b border-[#666666]/20 hover:bg-[#0D0D0D]">
      <td className="px-4 py-3 font-mono text-xs text-white max-w-xs truncate">
        {row.label}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-[#666666] tracking-widest uppercase">
        {row.provider}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <span
          className="font-mono text-[11px] tracking-widest uppercase border px-2 py-0.5"
          style={{ color: statusColor, borderColor: statusColor }}
        >
          [ {row.status.toUpperCase()} ]
        </span>
      </td>
      <td className="px-3 py-3 font-mono text-xs text-white tabular-nums whitespace-nowrap">
        {row.quotaMonthly !== null ? (
          <div className="flex flex-col gap-1 min-w-[9rem]">
            <span>
              {row.quotaUsed.toLocaleString("en-US")}
              <span className="text-[#666666]">
                {" "}
                / {row.quotaMonthly.toLocaleString("en-US")}
              </span>
              {pct !== null && (
                <span className="ml-2 text-[#666666]">{pct}%</span>
              )}
            </span>
            {pct !== null && (
              <div className="w-full h-[2px] bg-[#666666]/20 overflow-hidden">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: quotaColor,
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <span className="text-[#666666]">—</span>
        )}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap">
        {row.resetDayOfMonth !== null ? (
          <>
            J{row.resetDayOfMonth}
            {daysToReset !== null && (
              <span className="text-white">
                {" "}
                · dans {daysToReset}j
              </span>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums hidden md:table-cell">
        {row.rateLimitPerMin ?? "—"}
      </td>
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <div className="inline-flex gap-2">
          {row.status === "disabled" ? (
            <button
              type="button"
              onClick={onEnable}
              disabled={busy}
              className="interactive border border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
            >
              [ RÉACTIVER ]
            </button>
          ) : (
            <button
              type="button"
              onClick={onDisable}
              disabled={busy}
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
            >
              [ DÉSACTIVER ]
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-50"
          >
            [ SUPPRIMER ]
          </button>
        </div>
      </td>
    </tr>
  );
}

function AddKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [provider, setProvider] = useState<"instagram" | "tiktok">("instagram");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [quotaMonthly, setQuotaMonthly] = useState("130000");
  const [resetDay, setResetDay] = useState("2");
  const [ratePerMin, setRatePerMin] = useState("85");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    setErr(null);
    setSaving(true);
    try {
      const res = await fetch("/api/config/rapidapi-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          label: label.trim(),
          token: token.trim(),
          quotaMonthly: Number(quotaMonthly) || undefined,
          resetDayOfMonth: Number(resetDay) || undefined,
          rateLimitPerMin: Number(ratePerMin) || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error ?? `ÉCHEC ${res.status}`);
        return;
      }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      // z-50 reste sous le curseur custom (z-9998/9999 dans
      // globals.css) — sinon le backdrop masque le pointeur et on se
      // retrouve à cliquer à l'aveugle dans le formulaire.
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="max-w-lg w-full bg-[#030303] border border-[#FF3300] p-6 md:p-8 flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#666666]/20 pb-3">
          <span className="brand font-display text-xl tracking-tight uppercase text-white">
            Nouvelle clé.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="interactive text-[#666666] hover:text-white font-mono text-xs tracking-widest uppercase"
          >
            [ ✕ ]
          </button>
        </div>

        <Field
          label="PROVIDER"
          type="select"
          value={provider}
          onChange={(v) => setProvider(v as "instagram" | "tiktok")}
          options={[
            { value: "instagram", label: "INSTAGRAM" },
            { value: "tiktok", label: "TIKTOK" },
          ]}
        />
        <Field
          label="LABEL (MEMO)"
          value={label}
          onChange={setLabel}
          placeholder="ex: mega-01 — claude@example.com"
        />
        <Field
          label="TOKEN RAPIDAPI"
          value={token}
          onChange={setToken}
          type="password"
          placeholder="xxxxxxxxxxxxxxxxxxxx..."
        />
        <Field
          label="QUOTA MENSUEL"
          type="number"
          value={quotaMonthly}
          onChange={setQuotaMonthly}
          help="ex: 130000 pour le plan MEGA"
        />
        <Field
          label="JOUR DE RESET (1-31)"
          type="number"
          value={resetDay}
          onChange={setResetDay}
          help="jour du mois où RapidAPI reset ton quota"
        />
        <Field
          label="RATE LIMIT / MIN"
          type="number"
          value={ratePerMin}
          onChange={setRatePerMin}
          help="plafond requêtes/minute autorisé par ton plan"
        />

        {err && (
          <div className="font-mono text-[11px] text-[#FF3300] tracking-widest uppercase border border-[#FF3300]/40 px-3 py-2">
            {err}
          </div>
        )}

        <div className="flex items-center gap-3 justify-end pt-3 border-t border-[#666666]/20">
          <button
            type="button"
            onClick={onClose}
            className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase"
          >
            [ ANNULER ]
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !label.trim() || !token.trim()}
            className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
          >
            {saving ? "[ AJOUT... ]" : "[ AJOUTER ]"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  help,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password" | "number" | "select";
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}) {
  const cls =
    "interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      {type === "select" && options ? (
        <select
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={cls}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help && (
        <span className="font-mono text-[10px] text-[#666666] normal-case leading-snug">
          {help}
        </span>
      )}
    </label>
  );
}

function DocsBody() {
  return (
    <div className="border border-[#666666]/30 p-5 md:p-6 bg-[#030303] flex flex-col gap-5 font-mono text-[11px] text-[#CCCCCC] leading-relaxed normal-case tracking-wide">
      <section>
        <h3 className="text-[#FF3300] tracking-widest uppercase text-xs mb-2">
          Pourquoi multi-clés ?
        </h3>
        <p>
          Chaque clé RapidAPI a un quota mensuel. Une seule clé = point de
          défaillance unique : quand elle atteint son cap, tous les jobs
          IG s&apos;arrêtent jusqu&apos;au reset. Plusieurs clés en
          parallèle = redondance + capacité combinée.
        </p>
      </section>

      <section>
        <h3 className="text-[#FF3300] tracking-widest uppercase text-xs mb-2">
          Stratégie
        </h3>
        <p>
          <span className="text-white">Round-robin</span> à la création du
          job : la clé active la moins récemment utilisée est assignée au
          nouveau job. Ça répartit la charge entre toutes les clés actives
          sans avoir à choisir manuellement.
        </p>
        <p className="mt-2">
          <span className="text-white">Failover auto</span> pendant
          l&apos;exécution : si la clé en cours retourne une erreur de
          quota mensuel (429 &quot;quota exceeded&quot;), elle est flaguée
          <span className="text-[#FF3300]"> capped</span>, le job switche
          silencieusement vers une autre clé active et continue sans
          redémarrer.
        </p>
        <p className="mt-2">
          <span className="text-white">Rate-limit par seconde</span> (429
          &quot;too many requests&quot;) : géré séparément, retry avec
          backoff exponentiel. La clé reste active.
        </p>
      </section>

      <section>
        <h3 className="text-[#FF3300] tracking-widest uppercase text-xs mb-2">
          Raisons de jobs stuck
        </h3>
        <ul className="flex flex-col gap-2">
          <li>
            <span className="text-white">all_keys_capped</span> — toutes
            les clés ont atteint leur quota mensuel. Soit attendre le
            reset automatique (cron quotidien), soit ajouter une nouvelle
            clé.
          </li>
          <li>
            <span className="text-white">rate_limited_by_rapidapi</span> —
            trop d&apos;appels par seconde. Se régule tout seul (backoff
            auto). Pas grave, juste de la patience.
          </li>
          <li>
            <span className="text-white">budget_exhausted</span> — plafond
            interne du job atteint (config PoolConfig). Rarement un vrai
            problème.
          </li>
          <li>
            <span className="text-white">stale_no_progress</span> — aucun
            progrès depuis 30 min. Souvent un problème provider (RapidAPI
            down) ou un worker crashé.
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-[#FF3300] tracking-widest uppercase text-xs mb-2">
          Ajouter / retirer une clé sans casser les jobs en cours
        </h3>
        <p>
          L&apos;ajout est sans risque : la nouvelle clé entre dans le
          round-robin dès qu&apos;elle est
          <span className="text-[#00CC66]"> active</span>.
        </p>
        <p className="mt-2">
          Désactiver / supprimer une clé pendant qu&apos;un job
          l&apos;utilise : le job détecte le changement au prochain
          appel RapidAPI et failover vers une autre clé active. Pas de
          perte de checkpoint.
        </p>
      </section>

      <section>
        <h3 className="text-[#FF3300] tracking-widest uppercase text-xs mb-2">
          Bonnes pratiques
        </h3>
        <ul className="flex flex-col gap-1 list-disc pl-5">
          <li>Minimum 2-3 clés actives pour la redondance.</li>
          <li>
            Étale les jours de reset (ex: une clé J2, une autre J15) pour
            que tu ne sois jamais totalement capped en même temps.
          </li>
          <li>
            Label clair pour chaque clé (ex:{" "}
            <span className="text-white">&quot;mega-01 — amir@...&quot;</span>) pour savoir
            quel compte RapidAPI tu utilises.
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-[#666666] tracking-widest uppercase text-xs mb-2">
          Note sur le quota affiché
        </h3>
        <p className="text-[#666666]">
          Le quota affiché ici est calculé par CONTROL (incrémenté à
          chaque appel RapidAPI qui passe). Il peut légèrement différer
          du dashboard officiel RapidAPI à cause du délai de sync et des
          retries côté provider. Le dashboard RapidAPI reste la source
          de vérité pour la facturation.
        </p>
      </section>
    </div>
  );
}

// Days remaining until the next reset from resetDayOfMonth. Returns
// null when resetDayOfMonth is null.
function resetCountdownDays(resetDay: number | null): number | null {
  if (!resetDay) return null;
  const now = new Date();
  const thisMonthReset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay)
  );
  // Clamp to last day of the month.
  const lastDayThisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  ).getUTCDate();
  if (resetDay > lastDayThisMonth) {
    thisMonthReset.setUTCDate(lastDayThisMonth);
  }
  const target = thisMonthReset.getTime() > now.getTime()
    ? thisMonthReset
    : (() => {
        const next = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, resetDay)
        );
        const lastDayNext = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0)
        ).getUTCDate();
        if (resetDay > lastDayNext) next.setUTCDate(lastDayNext);
        return next;
      })();
  const diffMs = target.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)));
}
