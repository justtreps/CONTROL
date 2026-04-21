import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { PoolToastProvider } from "../PoolToast";
import { PoolAccountDetail } from "./PoolAccountDetail";

export const dynamic = "force-dynamic";

const STATUS_TOKEN: Record<string, { label: string; color: string }> = {
  available: { label: "AVAILABLE", color: "#FF3300" },
  assigned: { label: "ASSIGNED", color: "#FFCC00" },
  consumed: { label: "CONSUMED", color: "#666666" },
  invalid: { label: "INVALID", color: "#FFFFFF" },
  archived: { label: "ARCHIVED", color: "#444444" },
};

// Secondary badge used when status='invalid' — colors per-reason so a
// "deleted" row looks clearly different from a "became_active" row.
const REASON_TOKEN: Record<string, { label: string; color: string }> = {
  deleted: { label: "DELETED", color: "#FF3300" },
  became_active: { label: "BECAME ACTIVE", color: "#FFCC00" },
  became_private: { label: "BECAME PRIVATE", color: "#FFFFFF" },
  banned: { label: "BANNED", color: "#FF3300" },
  manual: { label: "MANUAL INVALIDATE", color: "#666666" },
};

export default async function PoolAccountPage({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return notFound();

  const account = await prisma.testAccount.findUnique({
    where: { id },
    include: {
      testOrders: {
        orderBy: { placedAt: "desc" },
        take: 10,
        include: {
          service: { select: { id: true, name: true, platform: true, serviceType: true } },
        },
      },
    },
  });
  if (!account) return notFound();

  const statusCfg = STATUS_TOKEN[account.status] ?? STATUS_TOKEN.available;
  const reasonCfg =
    account.status === "invalid" && account.invalidReason
      ? REASON_TOKEN[account.invalidReason] ?? {
          label: account.invalidReason.toUpperCase(),
          color: "#666666",
        }
      : null;
  const externalUrl =
    account.platform === "instagram"
      ? `https://www.instagram.com/${account.username}/`
      : account.platform === "tiktok"
        ? `https://www.tiktok.com/@${account.username}`
        : null;

  return (
    <PoolToastProvider>
      <DashboardHeader />

      {/* === Pattern B — Hero === */}
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-10 md:pb-12">
        <div className="max-w-7xl mx-auto">
          <Link
            href="/pool"
            className="interactive font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase"
          >
            ← COMPTES TEST
          </Link>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-end mt-6 md:mt-8">
            <div className="lg:col-span-8 min-w-0 flex flex-col">
              <div className="font-mono text-xs text-[#666666] tracking-widest mb-6 border border-[#666666]/30 px-3 py-1 w-max max-w-full truncate">
                [ ACCOUNT #{String(account.id).padStart(5, "0")} | PLATEFORME:{" "}
                {account.platform.toUpperCase()} | USER_ID: {account.userId} ]
              </div>
              <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0 break-words">
                @{account.username}
              </h1>
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <span
                  className="inline-block border px-3 py-1 font-mono text-xs tracking-widest uppercase"
                  style={{ borderColor: statusCfg.color, color: statusCfg.color }}
                >
                  [ {statusCfg.label} ]
                </span>
                {reasonCfg && (
                  <span
                    className="inline-block border px-3 py-1 font-mono text-xs tracking-widest uppercase"
                    style={{
                      borderColor: reasonCfg.color,
                      color: reasonCfg.color,
                    }}
                  >
                    [ {reasonCfg.label} ]
                  </span>
                )}
                {account.scrapeSource && (
                  <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
                    SOURCE: {account.scrapeSource.replace(/_/g, " ")}
                    {account.scrapeSeedAccount ? ` · FROM @${account.scrapeSeedAccount}` : ""}
                  </span>
                )}
              </div>
            </div>

            {/* Right column: live snapshot */}
            <div className="lg:col-span-4 min-w-0 font-mono text-xs tracking-widest uppercase">
              <BriefRow label="FIRST SEEN" value={fmt(account.firstSeenAt)} />
              <BriefRow label="LAST CHECKED" value={fmt(account.lastCheckedAt)} />
              {account.assignedAt && (
                <BriefRow label="ASSIGNED AT" value={fmt(account.assignedAt)} />
              )}
              {account.consumedAt && (
                <BriefRow label="CONSUMED AT" value={fmt(account.consumedAt)} />
              )}
              {account.invalidatedAt && (
                <BriefRow
                  label="INVALIDATED"
                  value={fmt(account.invalidatedAt)}
                  accent
                />
              )}
              {account.invalidReason && (
                <BriefRow
                  label="REASON"
                  value={
                    (REASON_TOKEN[account.invalidReason]?.label ??
                      account.invalidReason.toUpperCase())
                  }
                  accent
                />
              )}
              <BriefRow
                label="FOLLOWERS"
                value={
                  account.lastFollowerCount !== null
                    ? String(account.lastFollowerCount)
                    : "—"
                }
              />
              <BriefRow
                label="MEDIA"
                value={
                  account.lastMediaCount !== null
                    ? String(account.lastMediaCount)
                    : "—"
                }
              />
              <BriefRow
                label="FOLLOWING"
                value={
                  account.lastFollowingCount !== null
                    ? String(account.lastFollowingCount)
                    : "—"
                }
              />
            </div>
          </div>
        </div>
      </section>

      <div className="w-full h-px bg-[#666666]/20" />

      {/* === Section — Actions + Note (client) === */}
      <PoolAccountDetail
        id={account.id}
        initialNote={account.notes ?? ""}
        externalUrl={externalUrl}
        platform={account.platform}
      />

      {/* === Section — Test orders attached to this account === */}
      <section className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D]">
          [ TEST ORDERS LIÉS | {account.testOrders.length} ]
        </div>
        {account.testOrders.length === 0 ? (
          <div className="px-4 md:px-8 py-16 md:py-24 text-center font-mono text-xs text-[#666666] tracking-widest uppercase border-b border-[#666666]/20">
            AUCUNE COMMANDE TEST ATTACHÉE À CE COMPTE.
          </div>
        ) : (
          <div className="border-b border-[#666666]/20">
            <table className="w-full">
              <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
                <tr className="border-b border-[#666666]/20">
                  <th className="text-left px-4 py-3 font-normal">Date</th>
                  <th className="text-left px-3 py-3 font-normal">Service</th>
                  <th className="text-right px-3 py-3 font-normal">Qté</th>
                  <th className="text-right px-3 py-3 font-normal">Baseline</th>
                  <th className="text-left px-3 py-3 font-normal">BM ID</th>
                </tr>
              </thead>
              <tbody>
                {account.testOrders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
                  >
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-[#666666] tabular-nums">
                      {o.placedAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-3 py-3 max-w-xs">
                      <Link
                        href={`/services/${o.service.id}`}
                        className="interactive brand font-display text-sm uppercase tracking-tight text-white hover:text-[#FF3300] truncate block transition-colors"
                        title={o.service.name}
                      >
                        {o.service.name}
                      </Link>
                      <div className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-1">
                        [ {o.service.platform} / {o.service.serviceType} ]
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                      {o.targetQuantity}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                      {o.baselineCount}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-[#666666] truncate max-w-xs">
                      {o.bulkmedyaOrderId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PoolToastProvider>
  );
}

function BriefRow({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-2 border-b border-[#666666]/20 last:border-b-0 gap-4">
      <span className="text-[#666666]">{label}</span>
      <span className={`${accent ? "text-[#FF3300]" : "text-white"} text-right truncate`}>
        {value}
      </span>
    </div>
  );
}

function fmt(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19);
}
