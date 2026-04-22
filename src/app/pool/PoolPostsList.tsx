"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonRow } from "@/components/Skeleton";

// Engagement-universe counterpart of PoolAccountsList. Each row is a
// TestPost — URL + parent @username + natural likes + date + status.
// A single parent account can appear on multiple rows if its posts
// all passed the freshness / likes filters at scrape time.

type Post = {
  id: number;
  platform: string;
  mediaId: string;
  mediaUrl: string;
  mediaType: string;
  postedAt: string | null;
  naturalLikesCount: number;
  status: string;
  firstSeenAt: string;
  lastCheckedAt: string;
  testAccountId: number;
  parentUsername: string;
  detectedCountry: string | null;
  countryConfidence: string;
  invalidReason: string | null;
};

type ListResponse = {
  rows: Post[];
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
};

const COUNTRY_FLAGS: Record<string, string> = {
  FR: "🇫🇷", BR: "🇧🇷", US: "🇺🇸", GB: "🇬🇧", DE: "🇩🇪",
  ES: "🇪🇸", IT: "🇮🇹", IN: "🇮🇳", MX: "🇲🇽", TR: "🇹🇷",
  SA: "🇸🇦", AE: "🇦🇪", JP: "🇯🇵", KR: "🇰🇷", CN: "🇨🇳",
  RU: "🇷🇺", ID: "🇮🇩", NG: "🇳🇬", AR: "🇦🇷", CO: "🇨🇴",
  CL: "🇨🇱", PE: "🇵🇪", PT: "🇵🇹", NL: "🇳🇱", BE: "🇧🇪",
  PL: "🇵🇱", CA: "🇨🇦", AU: "🇦🇺", PH: "🇵🇭", TH: "🇹🇭",
  VN: "🇻🇳", EG: "🇪🇬", ZA: "🇿🇦", IR: "🇮🇷", PK: "🇵🇰",
  BD: "🇧🇩", MA: "🇲🇦", DZ: "🇩🇿", TN: "🇹🇳",
};

const FILTER =
  "interactive bg-transparent border border-[#666666]/40 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

export function PoolPostsList() {
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");
  const [country, setCountry] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("firstSeenAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(6);

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        platform,
        status,
        country,
        q,
        sort,
        order,
        page: String(page),
        limit: String(limit),
      });
      const res = await fetch(`/api/pool/posts?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      setData((await res.json()) as ListResponse);
    } finally {
      setLoading(false);
    }
  }, [platform, status, country, q, sort, order, page, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setPage(1);
  }, [platform, status, country, q, sort, order]);

  return (
    <section className="w-full">
      <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D] flex items-center gap-3 flex-wrap">
        <span>[ LISTE DES POSTS ]</span>
        <span className="normal-case text-[#666666]/70 text-[10px]">
          pool engagement · un compte parent peut apparaître plusieurs fois (1 ligne = 1 post)
        </span>
      </div>
      <div className="px-4 md:px-8 py-8 md:py-10">
        <div className="max-w-7xl mx-auto relative border border-[#666666]/30 pb-20 md:pb-24">
          {/* Filters */}
          <div className="flex flex-wrap gap-3 px-4 md:px-6 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
            <input
              placeholder="RECHERCHER USERNAME OU MEDIA_ID..."
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
            </select>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={FILTER}
              aria-label="Pays détecté"
            >
              <option value="all">TOUS PAYS</option>
              {Object.keys(COUNTRY_FLAGS).map((iso) => (
                <option key={iso} value={iso}>
                  {COUNTRY_FLAGS[iso]} {iso}
                </option>
              ))}
              <option value="unknown">INCONNU</option>
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
              <option value="postedAt:desc">TRI : POST LE + RÉCENT</option>
              <option value="naturalLikesCount:asc">TRI : - DE LIKES NAT.</option>
              <option value="naturalLikesCount:desc">TRI : + DE LIKES NAT.</option>
            </select>
          </div>

          {/* Tag */}
          <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none z-10">
            <span className="font-mono text-xs text-[#FF3300] tracking-widest">
              [ ASSET: POST-REGISTRY ]
            </span>
            <span className="font-mono text-xs text-white tracking-widest">
              ENGAGEMENT_DB
            </span>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
                <tr className="border-b border-[#666666]/20">
                  <th className="text-left px-4 py-3 font-normal">Post URL</th>
                  <th className="text-left px-3 py-3 font-normal">Compte parent</th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell">Plat.</th>
                  <th className="text-left px-3 py-3 font-normal hidden md:table-cell">Pays</th>
                  <th className="text-right px-3 py-3 font-normal">Likes nat.</th>
                  <th className="text-left px-3 py-3 font-normal hidden md:table-cell">Date post</th>
                  <th className="text-left px-3 py-3 font-normal">Status</th>
                  <th className="text-left px-3 py-3 font-normal hidden lg:table-cell">First Seen</th>
                </tr>
              </thead>
              <tbody aria-busy={loading} aria-live="polite">
                {loading && !data && (
                  <>
                    {Array.from({ length: Math.min(limit, 6) }).map((_, i) => (
                      <SkeletonRow key={`sk-${i}`} cols={8} />
                    ))}
                  </>
                )}
                {data?.rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
                  >
                    <td className="px-4 py-3 max-w-xs">
                      <a
                        href={r.mediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="interactive block brand font-display text-sm uppercase tracking-tight text-white truncate"
                        title={r.mediaUrl}
                      >
                        ↗ {r.mediaId}
                      </a>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Link
                        href={`/pool/${r.testAccountId}`}
                        className="interactive font-mono text-xs text-white hover:text-[#FF3300] transition-colors"
                      >
                        @{r.parentUsername}
                      </Link>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest hidden sm:table-cell">
                      {r.platform}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs tracking-widest hidden md:table-cell whitespace-nowrap">
                      {r.detectedCountry ? (
                        <span
                          title={`confidence: ${r.countryConfidence}`}
                          className={
                            r.countryConfidence === "low"
                              ? "text-[#666666]"
                              : "text-white"
                          }
                        >
                          {COUNTRY_FLAGS[r.detectedCountry] ?? ""} {r.detectedCountry}
                        </span>
                      ) : (
                        <span className="text-[#666666]/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                      {r.naturalLikesCount}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden md:table-cell">
                      {r.postedAt ? short(r.postedAt) : "—"}
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
                          · {r.invalidReason.toUpperCase()}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-[#666666] tabular-nums whitespace-nowrap hidden lg:table-cell">
                      {short(r.firstSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && data?.rows.length === 0 && (
              <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
                AUCUN POST NE CORRESPOND À CES FILTRES.
              </div>
            )}
          </div>

          {data && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-6 py-4 border-t border-[#666666]/20 font-mono text-xs tracking-widest uppercase">
              <div className="text-[#666666] tabular-nums flex items-center gap-4 flex-wrap">
                <span>
                  [ PAGE {String(page).padStart(2, "0")} /{" "}
                  {String(data.totalPages).padStart(2, "0")} ]
                </span>
                <span className="text-[#666666]/60">
                  {data.total.toLocaleString("en-US")} POSTS
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
