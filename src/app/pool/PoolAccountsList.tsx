"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";

type Account = {
  id: number;
  platform: string;
  username: string;
  userId: string;
  status: string;
  scrapeSource: string | null;
  firstSeenAt: string;
  lastCheckedAt: string;
  lastFollowerCount: number | null;
};

type ListResponse = {
  rows: Account[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const STATUS_COLOR: Record<string, string> = {
  available: "#FF3300",
  assigned: "#FFCC00",
  consumed: "#999999",
  invalid: "#FFFFFF",
  archived: "#666666",
};

const FILTER =
  "interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

export function PoolAccountsList() {
  const router = useRouter();
  const toast = usePoolToast();

  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("firstSeenAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState<Record<number, boolean>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        platform,
        status,
        source,
        q,
        sort,
        order,
        page: String(page),
        limit: String(limit),
      });
      const res = await fetch(`/api/pool/accounts?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      setData((await res.json()) as ListResponse);
    } finally {
      setLoading(false);
    }
  }, [platform, status, source, q, sort, order, page, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reset to page 1 on filter/search change.
  useEffect(() => {
    setPage(1);
  }, [platform, status, source, q, sort, order]);

  async function quickRecheck(id: number) {
    if (actioning[id]) return;
    setActioning((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/pool/accounts/${id}/recheck`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.push(
          data.invalidatedReason ? "err" : "ok",
          data.invalidatedReason
            ? `#${id} INVALIDÉ: ${String(data.invalidatedReason).toUpperCase()}`
            : `#${id} CHECK OK`
        );
        refresh();
        router.refresh();
      } else {
        toast.push("err", `#${id}: ${data.error ?? "ÉCHEC"}`);
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setActioning((s) => ({ ...s, [id]: false }));
    }
  }

  async function quickInvalidate(id: number) {
    if (actioning[id]) return;
    if (!confirm(`Marquer le compte #${id} comme INVALID ?`)) return;
    setActioning((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`/api/pool/accounts/${id}/invalidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual" }),
      });
      if (res.ok) {
        toast.push("ok", `#${id} INVALIDÉ`);
        refresh();
        router.refresh();
      } else {
        toast.push("err", `#${id} ÉCHEC`);
      }
    } catch {
      toast.push("err", "ERREUR RÉSEAU");
    } finally {
      setActioning((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <section className="px-4 md:px-8 py-12 md:py-16">
      <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-20 md:pb-24">
        {/* Filters */}
        <div className="flex flex-wrap gap-3 px-4 md:px-6 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
          <input
            placeholder="RECHERCHER USERNAME OU ID..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`${FILTER} w-full sm:w-64`}
          />
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className={FILTER}
          >
            <option value="all">TOUTES PLATEFORMES</option>
            <option value="instagram">INSTAGRAM</option>
            <option value="tiktok">TIKTOK</option>
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={FILTER}
          >
            <option value="all">TOUS STATUTS</option>
            <option value="available">AVAILABLE</option>
            <option value="assigned">ASSIGNED</option>
            <option value="consumed">CONSUMED</option>
            <option value="invalid">INVALID</option>
            <option value="archived">ARCHIVED</option>
          </select>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={FILTER}
          >
            <option value="all">TOUTES SOURCES</option>
            <option value="big_account_followers">BIG ACCOUNT FOLLOWERS</option>
            <option value="random_username">RANDOM USERNAME</option>
            <option value="manual">MANUAL</option>
          </select>
          <select
            value={`${sort}:${order}`}
            onChange={(e) => {
              const [s, o] = e.target.value.split(":");
              setSort(s);
              setOrder(o as "asc" | "desc");
            }}
            className={`${FILTER} sm:ml-auto`}
          >
            <option value="firstSeenAt:desc">TRI : + RÉCENT</option>
            <option value="firstSeenAt:asc">TRI : + ANCIEN</option>
            <option value="lastCheckedAt:asc">TRI : CHECK LE + VIEUX</option>
            <option value="lastFollowerCount:desc">TRI : + DE FOLLOWERS</option>
            <option value="username:asc">TRI : USERNAME A-Z</option>
          </select>
        </div>

        {/* Tag */}
        <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none z-10">
          <span className="font-mono text-xs text-[#FF3300] tracking-widest">
            [ ASSET: ACCOUNT-REGISTRY ]
          </span>
          <span className="font-mono text-xs text-white tracking-widest">
            POOL_DB
          </span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
              <tr className="border-b border-[#666666]/20">
                <th className="text-left px-4 py-3 font-normal">Username</th>
                <th className="text-left px-3 py-3 font-normal">User ID</th>
                <th className="text-left px-3 py-3 font-normal">Plat.</th>
                <th className="text-left px-3 py-3 font-normal">Status</th>
                <th className="text-left px-3 py-3 font-normal">Source</th>
                <th className="text-left px-3 py-3 font-normal">First Seen</th>
                <th className="text-left px-3 py-3 font-normal">Last Check</th>
                <th className="text-right px-3 py-3 font-normal">Followers</th>
                <th className="text-right px-3 py-3 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
                >
                  <td className="px-4 py-3 max-w-xs">
                    <Link
                      href={`/pool/${r.id}`}
                      className="interactive block brand font-display text-sm uppercase tracking-tight text-white truncate"
                      title={r.username}
                    >
                      @{r.username}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] truncate max-w-[8rem]">
                    {r.userId}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                    {r.platform}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className="font-mono text-xs tracking-widest uppercase"
                      style={{ color: STATUS_COLOR[r.status] ?? "#FFFFFF" }}
                    >
                      {r.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tracking-widest uppercase">
                    {r.scrapeSource ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap">
                    {short(r.firstSeenAt)}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap">
                    {short(r.lastCheckedAt)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                    {r.lastFollowerCount !== null ? r.lastFollowerCount : "—"}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => quickRecheck(r.id)}
                        disabled={Boolean(actioning[r.id])}
                        className="interactive font-mono text-xs text-[#FF3300] hover:text-white transition-colors disabled:opacity-50"
                      >
                        [ RECHECK ]
                      </button>
                      <button
                        type="button"
                        onClick={() => quickInvalidate(r.id)}
                        disabled={Boolean(actioning[r.id])}
                        className="interactive font-mono text-xs text-[#666666] hover:text-[#FF3300] transition-colors disabled:opacity-50"
                      >
                        [ INVALIDATE ]
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && data?.rows.length === 0 && (
            <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
              AUCUN COMPTE NE CORRESPOND À CES FILTRES.
            </div>
          )}
          {loading && (
            <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
              CHARGEMENT...
            </div>
          )}
        </div>

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-t border-[#666666]/20 font-mono text-xs tracking-widest uppercase">
            <div className="text-[#666666] tabular-nums">
              [ PAGE {String(page).padStart(2, "0")} / {String(data.totalPages).padStart(2, "0")} ]
              <span className="ml-4 text-[#666666]/60">
                {data.total.toLocaleString("en-US")} COMPTES
              </span>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← PRÉCÉDENT
              </button>
              <button
                type="button"
                disabled={page >= data.totalPages}
                onClick={() => setPage(page + 1)}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                SUIVANT →
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function short(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
