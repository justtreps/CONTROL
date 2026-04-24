"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Minimal modal to create a new `custom` workflow from scratch — a
// clean TRIGGER node is seeded so the editor has something to click.
export function CreateWorkflowButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          displayName: name.trim(),
          category: "custom",
          triggerType: "manual",
          nodes: [
            {
              id: "trigger",
              type: "TRIGGER",
              config: {},
              label: "start",
            },
          ],
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(typeof d.error === "string" ? d.error : "erreur");
        return;
      }
      setOpen(false);
      router.push(`/workflows/${slug.trim()}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase"
      >
        [ + CRÉER WORKFLOW ]
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-[#030303] border-2 border-[#FF3300] p-6 w-[480px] max-w-full flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#666666]/20 pb-3">
              <span className="brand font-display text-xl tracking-tight uppercase text-white">
                Nouveau workflow.
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="interactive text-[#666666] hover:text-white font-mono text-xs tracking-widest uppercase"
              >
                [ ✕ ]
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                SLUG (KEBAB-CASE)
              </span>
              <input
                className="interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="mon-workflow"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                NOM AFFICHÉ
              </span>
              <input
                className="interactive w-full bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mon Workflow"
              />
            </label>
            {err && (
              <div className="font-mono text-[11px] text-[#FF3300] tracking-widest uppercase border border-[#FF3300]/40 px-3 py-2">
                {err}
              </div>
            )}
            <div className="flex gap-3 justify-end pt-3 border-t border-[#666666]/20">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
              >
                [ ANNULER ]
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !slug.trim() || !name.trim()}
                className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60"
              >
                {busy ? "[ CRÉATION… ]" : "[ CRÉER ]"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
