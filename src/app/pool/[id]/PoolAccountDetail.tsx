"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { usePoolToast } from "../PoolToast";

type Props = {
  id: number;
  initialNote: string;
  externalUrl: string | null;
  platform: string;
};

export function PoolAccountDetail({
  id,
  initialNote,
  externalUrl,
  platform,
}: Props) {
  const router = useRouter();
  const toast = usePoolToast();
  const { show, hide } = useLoading();

  const [note, setNote] = useState(initialNote);
  const [savingNote, setSavingNote] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [invalidating, setInvalidating] = useState(false);

  async function saveNote() {
    if (savingNote) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/pool/accounts/${id}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (res.ok) {
        toast.push("ok", "NOTE SAUVEGARDÉE");
        router.refresh();
      } else {
        toast.push("err", "ÉCHEC SAUVEGARDE");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setSavingNote(false);
    }
  }

  async function forceRecheck() {
    if (rechecking) return;
    setRechecking(true);
    show();
    try {
      const res = await fetch(`/api/pool/accounts/${id}/recheck`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.invalidatedReason) {
          toast.push("err", `INVALIDÉ: ${data.invalidatedReason.toUpperCase()}`);
        } else {
          toast.push("ok", "CHECK OK — TOUJOURS VIERGE");
        }
        router.refresh();
      } else {
        toast.push("err", data.error ?? "ÉCHEC");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setTimeout(() => {
        hide();
        setRechecking(false);
      }, 400);
    }
  }

  async function forceInvalidate() {
    if (invalidating) return;
    if (!confirm("Marquer ce compte comme INVALID ?")) return;
    setInvalidating(true);
    try {
      const res = await fetch(`/api/pool/accounts/${id}/invalidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual" }),
      });
      if (res.ok) {
        toast.push("ok", "COMPTE INVALIDÉ");
        router.refresh();
      } else {
        toast.push("err", "ÉCHEC");
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setInvalidating(false);
    }
  }

  return (
    <section className="px-4 md:px-8 py-12 md:py-16">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-0 border border-[#666666]/30">
        {/* Left: NOTE editor */}
        <div className="p-6 md:p-8 md:border-r border-[#666666]/20">
          <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-3">
            [ NOTE ADMIN ]
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={5}
            placeholder="AJOUTER UNE NOTE..."
            className="interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/50 outline-none transition-colors resize-none"
          />
          <button
            type="button"
            onClick={saveNote}
            disabled={savingNote}
            className="interactive mt-3 border border-white bg-white text-black py-2 px-4 font-mono text-xs tracking-widest uppercase hover:bg-[#FF3300] hover:border-[#FF3300] hover:text-black transition-colors disabled:opacity-60"
          >
            {savingNote ? "[ SAUVEGARDE... ]" : "[ SAUVEGARDER ]"}
          </button>
        </div>

        {/* Right: Actions */}
        <div className="p-6 md:p-8">
          <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mb-3">
            [ ACTIONS ]
          </div>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={forceRecheck}
              disabled={rechecking}
              className="interactive w-full border border-[#FF3300] bg-[#FF3300] text-black py-3 px-4 font-mono text-xs tracking-widest uppercase flex justify-between items-center disabled:opacity-60"
            >
              <span>
                {rechecking ? "[ PROBING... ]" : "[ FORCE RECHECK ]"}
              </span>
              <span>→</span>
            </button>
            <button
              type="button"
              onClick={forceInvalidate}
              disabled={invalidating}
              className="interactive w-full border border-[#FF3300] text-[#FF3300] bg-transparent py-3 px-4 font-mono text-xs tracking-widest uppercase flex justify-between items-center hover:bg-[#FF3300] hover:text-black transition-colors disabled:opacity-60"
            >
              <span>
                {invalidating ? "[ INVALIDATION... ]" : "[ INVALIDATE ]"}
              </span>
              <span>✕</span>
            </button>
            {externalUrl && (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="interactive w-full border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white py-3 px-4 font-mono text-xs tracking-widest uppercase flex justify-between items-center transition-colors"
              >
                <span>[ VIEW ON {platform.toUpperCase()} ]</span>
                <span>↗</span>
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
