"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoolToast } from "./PoolToast";
import { SkeletonRow } from "@/components/Skeleton";

type Account = {
  id: number;
  platform: string;
  username: string;
  userId: string;
  status: string;
  invalidReason: string | null;
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

const REASON_SHORT: Record<string, string> = {
  deleted: "DELETED",
  became_active: "ACTIVE",
  became_private: "PRIVATE",
  banned: "BANNED",
  manual: "MANUAL",
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
  const [limit, setLimit] = useState(6);

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
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D] flex items-center gap-3 flex-wrap">
        <span>[ LISTE DES COMPTES ]</span>
        <span className="normal-case text-[#666666]/70 text-[10px]">
          tous les comptes test de la réserve · cherche par username / ID, filtre par statut
        </span>
      </div>
      <div className="px-4 md:px-8 py-8 md:py-10">
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
                <th className="text-left px-3 py-3 font-normal hidden lg:table-cell">
                  User ID
                </th>
                <th className="text-left px-3 py-3 font-normal hidden sm:table-cell">
                  Plat.
                </th>
                <th className="text-left px-3 py-3 font-normal">Status</th>
                <th className="text-left px-3 py-3 font-normal hidden xl:table-cell">
                  Source
                </th>
                <th className="text-left px-3 py-3 font-normal hidden lg:table-cell">
                  First Seen
                </th>
                <th className="text-left px-3 py-3 font-normal hidden md:table-cell">
                  Last Check
                </th>
                <th className="text-right px-3 py-3 font-normal">Followers</th>
                <th className="text-right px-3 py-3 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody aria-busy={loading} aria-live="polite">
              {loading && !data && (
                <>
                  {Array.from({ length: Math.min(limit, 6) }).map((_, i) => (
                    <SkeletonRow key={`sk-${i}`} cols={9} />
                  ))}
                </>
              )}
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
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] truncate max-w-[8rem] hidden lg:table-cell">
                    {r.userId}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest hidden sm:table-cell">
                    {r.platform}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span
                      className="font-mono text-xs tracking-widest uppercase"
                      style={{ color: STATUS_COLOR[r.status] ?? "#FFFFFF" }}
                    >
                      {r.status.toUpperCase()}
                    </span>
                    {r.status === "invalid" && r.invalidReason && (
                      <span className="ml-2 font-mono text-[10px] text-[#666666] tracking-widest uppercase">
                        ·{" "}
                        {REASON_SHORT[r.invalidReason] ??
                          r.invalidReason.toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tracking-widest uppercase hidden xl:table-cell">
                    {r.scrapeSource ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden lg:table-cell">
                    {short(r.firstSeenAt)}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden md:table-cell">
                    {short(r.lastCheckedAt)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                    {r.lastFollowerCount !== null ? r.lastFollowerCount : "—"}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => quickRecheck(r.id)}
                        disabled={Boolean(actioning[r.id])}
                        className="interactive font-mono text-xs text-[#FF3300] hover:text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        [&nbsp;RECHECK&nbsp;]
                      </button>
                      <button
                        type="button"
                        onClick={() => quickInvalidate(r.id)}
                        disabled={Boolean(actioning[r.id])}
                        className="interactive font-mono text-xs text-[#666666] hover:text-[#FF3300] transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        [&nbsp;INVALIDATE&nbsp;]
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
        </div>

        {/* Pagination */}
        {data && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-6 py-4 border-t border-[#666666]/20 font-mono text-xs tracking-widest uppercase">
            <div className="text-[#666666] tabular-nums flex items-center gap-4 flex-wrap">
              <span>
                [ PAGE {String(page).padStart(2, "0")} / {String(data.totalPages).padStart(2, "0")} ]
              </span>
              <span className="text-[#666666]/60">
                {data.total.toLocaleString("en-US")} COMPTES
              </span>
              <label className="flex items-center gap-2">
                <span className="text-[#666666]/60">PER PAGE</span>
                <select
                  value={limit}
                  onChange={(e) => {
                    setLimit(Number(e.target.value));
                    setPage(1);
                  }}
                  className="interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-2 py-1 font-mono text-xs tracking-widest uppercase text-white outline-none"
                >
                  <option value={6}>6</option>
                  <option value={12}>12</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                [ ← ]
              </button>
              <button
                type="button"
                disabled={page >= data.totalPages}
                onClick={() => setPage(page + 1)}
                className="interactive border border-[#666666]/40 text-[#666666] hover:text-white hover:border-white px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                [ → ]
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </section>
  );
}

function short(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
