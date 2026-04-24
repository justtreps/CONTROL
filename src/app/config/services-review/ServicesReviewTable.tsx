"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isTestableService, whyNotTestable } from "@/lib/services/testable";
import { PRODUCT_SEEDS } from "@/lib/catalogue/products";

type Filter = "pending" | "never" | "6mo" | "1y" | "2y";

type Row = {
  id: number;
  bulkmedyaId: number;
  name: string;
  platform: string;
  serviceType: string;
  poolType: string;
  targetCountry: string | null;
  classificationManualReview: boolean;
  active: boolean;
  lastTestedAt: string | null;
  suspectWording: boolean;
};

type PoolType = "follower_test" | "engagement_test" | "unknown";

export function ServicesReviewTable({
  initial,
  filter,
  totalCount,
}: {
  initial: Row[];
  filter: Filter;
  totalCount: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial);
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  // PATCH handler — used by the `pending` tab's decision buttons.
  async function decide(id: number, poolType: PoolType) {
    if (busy[id]) return;
    setBusy((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/config/services/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolType,
          classificationManualReview: false,
        }),
      });
      if (res.ok) {
        setRows((xs) => xs.filter((r) => r.id !== id));
        router.refresh();
      }
    } finally {
      setBusy((s) => ({ ...s, [id]: false }));
    }
  }

  // Operator-force-link a service to a specific MyBoost product —
  // bypasses the classifier's verdict entirely. The candidate row
  // lands with isEligible=true + forceExcluded=false, so the next
  // testbot + scoring cycle will pick it up naturally.
  async function forceLink(id: number, slug: string) {
    if (busy[id] || !slug) return;
    setBusy((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/catalogue/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productSlug: slug, serviceId: id }),
      });
      if (res.ok) {
        // Clearing the manual-review flag so the row drops out of the
        // pending tab; the candidate is now tracked in /config/catalogue.
        await fetch(`/api/config/services/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ classificationManualReview: false }),
        });
        setRows((xs) => xs.filter((r) => r.id !== id));
        router.refresh();
      }
    } finally {
      setBusy((s) => ({ ...s, [id]: false }));
    }
  }

  // Hard-disable handler — used by the obsolescence tabs to retire a
  // service without bumping it through the pending queue.
  async function disable(id: number) {
    if (busy[id]) return;
    if (!confirm("Désactiver ce service ? Il ne sera plus routé ni testé.")) {
      return;
    }
    setBusy((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/config/services/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      if (res.ok) {
        setRows((xs) => xs.filter((r) => r.id !== id));
        router.refresh();
      }
    } finally {
      setBusy((s) => ({ ...s, [id]: false }));
    }
  }

  if (rows.length === 0) {
    return (
      <section className="px-4 md:px-8 pb-24 pt-6">
        <div className="max-w-7xl mx-auto border border-[#666666]/30 px-6 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
          {filter === "pending"
            ? "AUCUN SERVICE EN ATTENTE — TOUT EST CLASSIFIÉ."
            : "AUCUN SERVICE OBSOLÈTE DANS CETTE FENÊTRE."}
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 md:px-8 pb-24 pt-6">
      <div className="max-w-7xl mx-auto border border-[#666666]/30">
        {filter === "pending" && (
          <div className="px-4 md:px-6 py-3 border-b border-[#666666]/20 bg-[#0D0D0D] font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case leading-relaxed">
            Rappel : le testbot tourne UNIQUEMENT sur les services vendables
            (IG/TT · followers/likes/views/shares/saves · poolType décidé ·
            pas de manual review). Les rows ci-dessous sont toutes{" "}
            <span className="text-[#FFCC00]">IGNORÉES</span> tant qu&apos;elles
            restent en triage — une fois tranchées, elles passent{" "}
            <span className="text-[#FF3300]">TESTÉES</span> (si{" "}
            <em>abonnés</em> ou <em>engagement</em>) ou restent ignorées (si{" "}
            <em>ignorer</em>).
          </div>
        )}
        {filter !== "pending" && (
          <div className="px-4 md:px-6 py-3 border-b border-[#666666]/20 bg-[#0D0D0D] font-mono text-[10px] text-[#666666] tracking-widest uppercase normal-case leading-relaxed">
            {totalCount > rows.length && (
              <span className="text-[#FFCC00]">
                {rows.length} affichés sur {totalCount} — limite 500.{" "}
              </span>
            )}
            Ces services sont routables (poolType décidé) mais{" "}
            {filter === "never"
              ? "jamais passés par le testbot."
              : `n'ont pas été retestés depuis ${filterHuman(filter)}.`}{" "}
            Probables candidats à désactiver si BulkMedya les a retirés.
          </div>
        )}
        <table className="w-full">
          <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-4 py-3 font-normal">Service</th>
              <th className="text-left px-3 py-3 font-normal">Plat.</th>
              <th className="text-left px-3 py-3 font-normal hidden md:table-cell">
                Pool
              </th>
              <th className="text-left px-3 py-3 font-normal">Pays</th>
              <th className="text-left px-3 py-3 font-normal whitespace-nowrap">
                Dernier test
              </th>
              <th className="text-left px-3 py-3 font-normal">Testbot</th>
              <th className="text-right px-3 py-3 font-normal">
                {filter === "pending" ? "Décision" : "Action"}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-[#666666]/20 hover:bg-[#0D0D0D]"
              >
                <td className="px-4 py-3 font-mono text-xs text-white max-w-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate" title={`${r.name} [#${r.bulkmedyaId}]`}>
                      {r.name}
                    </div>
                    {r.suspectWording && (
                      <span
                        className="inline-block font-mono text-[9px] tracking-widest uppercase border border-[#FFCC00] text-[#FFCC00] px-1.5 py-0"
                        title="Le nom contient un mot-clé signalant un service provider potentiellement obsolète (old/legacy/deprecated/fix/after update/…)"
                      >
                        ⚠ SUSPECT WORDING
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-[#FF3300]/80 tracking-widest mt-1">
                    #{r.bulkmedyaId}
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.platform}
                </td>
                <td className="px-3 py-3 font-mono text-[10px] text-[#666666] uppercase tracking-widest hidden md:table-cell">
                  {poolLabel(r.poolType)}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.targetCountry ?? "—"}
                </td>
                <td className="px-3 py-3 font-mono text-[11px] text-[#666666] whitespace-nowrap">
                  {formatLastTested(r.lastTestedAt)}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <TestbotBadge row={r} />
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  {filter === "pending" ? (
                    <div className="inline-flex items-center gap-2 flex-wrap justify-end">
                      <select
                        defaultValue=""
                        disabled={busy[r.id]}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) forceLink(r.id, v);
                          e.currentTarget.value = "";
                        }}
                        title="Forcer ce service comme candidat d'un produit MyBoost"
                        className="interactive bg-transparent border border-[#FF3300]/70 text-[#FF3300] px-2 py-1 font-mono text-[11px] tracking-widest uppercase outline-none disabled:opacity-60"
                      >
                        <option value="" disabled>
                          [ FORCER → ]
                        </option>
                        {PRODUCT_SEEDS.filter(
                          (p) => p.platform === r.platform
                        ).map((p) => (
                          <option key={p.slug} value={p.slug}>
                            {p.slug}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => decide(r.id, "follower_test")}
                        disabled={busy[r.id]}
                        className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
                      >
                        [ ABONNÉS ]
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(r.id, "engagement_test")}
                        disabled={busy[r.id]}
                        className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
                      >
                        [ ENGAGEMENT ]
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(r.id, "unknown")}
                        disabled={busy[r.id]}
                        className="interactive border border-[#666666]/40 text-[#666666] hover:text-white transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
                        title="Laisser en 'unknown' (le service ne sera pas testé automatiquement)"
                      >
                        [ IGNORER ]
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => disable(r.id)}
                      disabled={busy[r.id]}
                      className="interactive border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
                    >
                      [ DÉSACTIVER ]
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Visual feedback on whether a row would currently be picked by the
// testbot's sellable-services filter.
function TestbotBadge({ row }: { row: Row }) {
  const testable = isTestableService(row);
  const reason = whyNotTestable(row);
  if (testable) {
    return (
      <span
        className="inline-block font-mono text-[10px] tracking-widest uppercase border border-[#FF3300] text-[#FF3300] px-2 py-0.5"
        title="Ce service est pické par le cron testbot"
      >
        TESTÉ
      </span>
    );
  }
  return (
    <span
      className="inline-block font-mono text-[10px] tracking-widest uppercase border border-[#666666]/60 text-[#666666] px-2 py-0.5"
      title={reason ? `Ignoré par le testbot · ${reason}` : "Ignoré par le testbot"}
    >
      IGNORÉ PAR TESTBOT
    </span>
  );
}

function formatLastTested(iso: string | null): string {
  if (!iso) return "JAMAIS";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
  if (days < 1) return "AUJOURD'HUI";
  if (days < 30) return `IL Y A ${days}J`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `IL Y A ${months} MOIS`;
  }
  const years = (days / 365).toFixed(1);
  return `IL Y A ${years} AN${Number(years) >= 2 ? "S" : ""}`;
}

function filterHuman(f: Filter): string {
  switch (f) {
    case "6mo":
      return "6 mois";
    case "1y":
      return "1 an";
    case "2y":
      return "2 ans";
    default:
      return "";
  }
}

function poolLabel(pt: string): string {
  if (pt === "follower_test") return "FOLLOWER";
  if (pt === "engagement_test") return "ENGAGEMENT";
  return "—";
}
