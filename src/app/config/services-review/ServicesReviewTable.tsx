"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isTestableService, whyNotTestable } from "@/lib/services/testable";

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
};

type PoolType = "follower_test" | "engagement_test" | "unknown";

export function ServicesReviewTable({ initial }: { initial: Row[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial);
  const [busy, setBusy] = useState<Record<number, boolean>>({});

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

  if (rows.length === 0) {
    return (
      <section className="px-4 md:px-8 pb-24">
        <div className="max-w-7xl mx-auto border border-[#666666]/30 px-6 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
          AUCUN SERVICE EN ATTENTE — TOUT EST CLASSIFIÉ.
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 md:px-8 pb-24">
      <div className="max-w-7xl mx-auto border border-[#666666]/30">
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
        <table className="w-full">
          <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-4 py-3 font-normal">Service</th>
              <th className="text-left px-3 py-3 font-normal">Plat.</th>
              <th className="text-left px-3 py-3 font-normal">Pays</th>
              <th className="text-left px-3 py-3 font-normal">Testbot</th>
              <th className="text-right px-3 py-3 font-normal">Décision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-[#666666]/20 hover:bg-[#0D0D0D]"
              >
                <td className="px-4 py-3 font-mono text-xs text-white max-w-md truncate">
                  <div className="truncate" title={`${r.name} [#${r.bulkmedyaId}]`}>
                    {r.name}
                  </div>
                  <div className="font-mono text-[10px] text-[#FF3300]/80 tracking-widest mt-1">
                    #{r.bulkmedyaId}
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.platform}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.targetCountry ?? "—"}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <TestbotBadge row={r} />
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <div className="inline-flex gap-2">
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
// testbot's sellable-services filter. On this page every row is in
// manual review so the badge always reads IGNORÉ until the operator
// decides — once decided (ABONNÉS / ENGAGEMENT), the row drops out of
// the query and becomes TESTÉ on /services.
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
