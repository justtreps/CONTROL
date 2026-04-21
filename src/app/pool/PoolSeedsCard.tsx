"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";

type Seed = {
  id: number;
  platform: string;
  username: string;
  enabled: boolean;
  priority: number;
  addedAt: string;
};

type Suggestion = {
  platform: string;
  username: string;
};

const INPUT_CLS =
  "interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

export function PoolSeedsCard() {
  const router = useRouter();
  const toast = usePoolToast();

  const [platform, setPlatform] = useState<"instagram" | "tiktok">("instagram");
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(
    new Set()
  );
  const [addUsername, setAddUsername] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [seedsRes, sugRes] = await Promise.all([
      fetch(`/api/pool/seeds?platform=${platform}`, { cache: "no-store" }),
      fetch(`/api/pool/seeds/suggestions?platform=${platform}&count=10`, {
        cache: "no-store",
      }),
    ]);
    if (seedsRes.ok) {
      const d = (await seedsRes.json()) as { rows: Seed[] };
      setSeeds(d.rows);
    }
    if (sugRes.ok) {
      const d = (await sugRes.json()) as { rows: Suggestion[] };
      setSuggestions(d.rows);
      setSelectedSuggestions(new Set());
    }
  }, [platform]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addSeed() {
    const u = addUsername.trim();
    if (!u) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pool/seeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, username: u }),
      });
      if (res.ok) {
        toast.push("ok", `SEED @${u} ADDED`);
        setAddUsername("");
        await refresh();
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.push("err", d.error ?? "ADD FAILED");
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleSeed(s: Seed) {
    const res = await fetch(`/api/pool/seeds/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    if (res.ok) {
      toast.push("ok", `@${s.username} ${!s.enabled ? "ENABLED" : "DISABLED"}`);
      await refresh();
    } else {
      toast.push("err", "UPDATE FAILED");
    }
  }

  async function changePriority(s: Seed, delta: number) {
    const next = s.priority + delta;
    const res = await fetch(`/api/pool/seeds/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: next }),
    });
    if (res.ok) await refresh();
  }

  async function deleteSeed(s: Seed) {
    if (!confirm(`Supprimer le seed @${s.username} ?`)) return;
    const res = await fetch(`/api/pool/seeds/${s.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.push("ok", `@${s.username} DELETED`);
      await refresh();
      router.refresh();
    } else {
      toast.push("err", "DELETE FAILED");
    }
  }

  async function integrateUsernames(usernames: string[]) {
    if (usernames.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pool/seeds/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, integrate: usernames }),
      });
      if (res.ok) {
        const d = await res.json();
        toast.push("ok", `${d.integrated} SEEDS ADDED`);
        await refresh();
        router.refresh();
      } else {
        toast.push("err", "INTEGRATE FAILED");
      }
    } finally {
      setBusy(false);
    }
  }

  async function rejectUsernames(usernames: string[]) {
    if (usernames.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pool/seeds/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, reject: usernames }),
      });
      if (res.ok) {
        toast.push("ok", `${usernames.length} SUGGESTIONS REJECTED`);
        await refresh();
      } else {
        toast.push("err", "REJECT FAILED");
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(username: string) {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  }

  const enabledCount = seeds.filter((s) => s.enabled).length;

  return (
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D] flex items-center justify-between flex-wrap gap-2">
        <span>
          [ SEEDS METHOD A | {enabledCount}/{seeds.length} ACTIVE · {platform.toUpperCase()} ]
        </span>
        <div className="flex gap-2">
          {(["instagram", "tiktok"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPlatform(p)}
              className={`interactive px-3 py-1 border font-mono text-[11px] tracking-widest uppercase transition-colors ${
                platform === p
                  ? "bg-[#FF3300] border-[#FF3300] text-black"
                  : "border-[#666666]/40 text-[#666666] hover:text-white"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 w-full border-b border-[#666666]/20">
        {/* LEFT — active seeds */}
        <div className="p-6 md:p-8 bg-[#030303] lg:border-r border-[#666666]/20">
          <h3 className="brand font-display text-xl uppercase tracking-tight text-white mb-4">
            Active Seeds
          </h3>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              placeholder={`@USERNAME ${platform.toUpperCase()}`}
              className={`${INPUT_CLS} flex-1`}
              onKeyDown={(e) => e.key === "Enter" && addSeed()}
            />
            <button
              type="button"
              onClick={addSeed}
              disabled={busy || !addUsername.trim()}
              className="interactive border border-[#FF3300] bg-[#FF3300] text-black px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
            >
              [ + ADD ]
            </button>
          </div>

          {seeds.length === 0 ? (
            <div className="font-mono text-xs text-[#666666] tracking-widest uppercase py-8 text-center border border-[#666666]/20">
              AUCUN SEED POUR CETTE PLATEFORME.
            </div>
          ) : (
            <div className="border-t border-[#666666]/20">
              {seeds.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 py-2 border-b border-[#666666]/20 font-mono text-xs tracking-widest uppercase hover:bg-[#0D0D0D]"
                >
                  <button
                    type="button"
                    onClick={() => toggleSeed(s)}
                    className={`interactive flex-shrink-0 border px-2 py-1 text-[10px] transition-colors ${
                      s.enabled
                        ? "border-[#FF3300] text-[#FF3300]"
                        : "border-[#666666]/40 text-[#666666]"
                    }`}
                  >
                    {s.enabled ? "ON" : "OFF"}
                  </button>
                  <span className="flex-1 text-white truncate">
                    @{s.username}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => changePriority(s, -1)}
                      className="interactive text-[#666666] hover:text-white px-1"
                      aria-label={`Baisser la priorité de @${s.username}`}
                    >
                      −
                    </button>
                    <span className="text-[#666666] w-6 text-center tabular-nums">
                      {s.priority}
                    </span>
                    <button
                      type="button"
                      onClick={() => changePriority(s, +1)}
                      className="interactive text-[#666666] hover:text-white px-1"
                      aria-label={`Monter la priorité de @${s.username}`}
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteSeed(s)}
                    className="interactive text-[#FF3300] hover:text-white px-1"
                    aria-label={`Supprimer le seed @${s.username}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — suggestions */}
        <div className="p-6 md:p-8 bg-[#0D0D0D]">
          <h3 className="brand font-display text-xl uppercase tracking-tight text-white mb-4">
            Suggestions
          </h3>

          {suggestions.length === 0 ? (
            <div className="font-mono text-xs text-[#666666] tracking-widest uppercase py-8 text-center border border-[#666666]/20">
              PLUS DE SUGGESTIONS — TOUTES INTÉGRÉES OU REJETÉES.
            </div>
          ) : (
            <div className="border-t border-[#666666]/20">
              {suggestions.map((s) => (
                <div
                  key={s.username}
                  className="flex items-center gap-3 py-2 border-b border-[#666666]/20 font-mono text-xs tracking-widest uppercase hover:bg-[#030303]"
                >
                  <input
                    type="checkbox"
                    checked={selectedSuggestions.has(s.username)}
                    onChange={() => toggleSelected(s.username)}
                    className="interactive accent-[#FF3300]"
                  />
                  <span className="flex-1 text-white truncate">
                    @{s.username}
                  </span>
                  <button
                    type="button"
                    onClick={() => integrateUsernames([s.username])}
                    disabled={busy}
                    className="interactive text-[#FF3300] hover:text-white disabled:opacity-50"
                    aria-label={`Intégrer la suggestion @${s.username}`}
                  >
                    [ + ]
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectUsernames([s.username])}
                    disabled={busy}
                    className="interactive text-[#666666] hover:text-white disabled:opacity-50"
                    aria-label={`Rejeter la suggestion @${s.username}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => integrateUsernames(Array.from(selectedSuggestions))}
              disabled={busy || selectedSuggestions.size === 0}
              className="interactive flex-1 border border-[#FF3300] bg-[#FF3300] text-black px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
            >
              [ + INTEGRATE SELECTED ({selectedSuggestions.size}) ]
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={busy}
              className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 font-mono text-xs tracking-widest uppercase transition-colors disabled:opacity-60"
            >
              [ ↻ REFRESH ]
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
