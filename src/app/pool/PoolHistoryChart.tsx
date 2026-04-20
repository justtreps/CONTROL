"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

type StatusBreakdown = {
  available: number;
  assigned: number;
  consumed: number;
  invalid: number;
  archived: number;
};

type Day = {
  date: string;
  instagram: StatusBreakdown;
  tiktok: StatusBreakdown;
};

type Props = { initialData: Day[] };

type PlatformFilter = "both" | "instagram" | "tiktok";
type StatusKey = "available" | "assigned" | "consumed" | "invalid";

const STATUS_COLORS: Record<StatusKey, string> = {
  available: "#FF3300",
  assigned: "#FFCC00",
  consumed: "#999999",
  invalid: "#FFFFFF",
};

export function PoolHistoryChart({ initialData }: Props) {
  const [platform, setPlatform] = useState<PlatformFilter>("both");
  const [visible, setVisible] = useState<Record<StatusKey, boolean>>({
    available: true,
    assigned: true,
    consumed: true,
    invalid: true,
  });

  const data = useMemo(() => {
    return initialData.map((d) => {
      const ig = d.instagram;
      const tt = d.tiktok;
      const sum = (a: StatusBreakdown, b: StatusBreakdown, k: StatusKey) =>
        a[k] + b[k];
      if (platform === "instagram") {
        return {
          date: formatDate(d.date),
          available: ig.available,
          assigned: ig.assigned,
          consumed: ig.consumed,
          invalid: ig.invalid,
        };
      }
      if (platform === "tiktok") {
        return {
          date: formatDate(d.date),
          available: tt.available,
          assigned: tt.assigned,
          consumed: tt.consumed,
          invalid: tt.invalid,
        };
      }
      return {
        date: formatDate(d.date),
        available: sum(ig, tt, "available"),
        assigned: sum(ig, tt, "assigned"),
        consumed: sum(ig, tt, "consumed"),
        invalid: sum(ig, tt, "invalid"),
      };
    });
  }, [initialData, platform]);

  function toggleStatus(k: StatusKey) {
    setVisible((v) => ({ ...v, [k]: !v[k] }));
  }

  return (
    <section className="px-4 md:px-8 pb-12 md:pb-16">
      <div className="max-w-7xl mx-auto relative border border-[#666666]/30 p-5 md:p-8 pb-20 md:pb-24">
        <div className="absolute bottom-4 left-4 flex flex-col gap-1 bg-[#030303]/80 p-3 backdrop-blur-sm pointer-events-none z-10">
          <span className="font-mono text-xs text-[#FF3300] tracking-widest">
            [ ASSET: POOL-EVOLUTION ]
          </span>
          <span className="font-mono text-xs text-white tracking-widest">
            30-DAY-HISTORY
          </span>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-4 md:gap-6 mb-6 font-mono text-xs tracking-widest uppercase">
          <div className="flex items-center gap-2">
            <span className="text-[#666666]">PLATFORM</span>
            {(
              [
                ["both", "ALL"],
                ["instagram", "IG"],
                ["tiktok", "TT"],
              ] as Array<[PlatformFilter, string]>
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setPlatform(k)}
                className={`interactive px-3 py-1 border transition-colors ${
                  platform === k
                    ? "bg-[#FF3300] border-[#FF3300] text-black"
                    : "border-[#666666]/40 text-[#666666] hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#666666]">STATUS</span>
            {(
              Object.keys(visible) as StatusKey[]
            ).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => toggleStatus(k)}
                className={`interactive px-3 py-1 border transition-colors ${
                  visible[k]
                    ? "text-white border-[#666666]/40"
                    : "text-[#666666]/40 border-[#666666]/20 line-through"
                }`}
                style={visible[k] ? { color: STATUS_COLORS[k], borderColor: STATUS_COLORS[k] + "60" } : undefined}
              >
                {k.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full h-64 md:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 12, left: -12, bottom: 4 }}>
              <CartesianGrid stroke="#666666" strokeOpacity={0.12} vertical={false} />
              <XAxis
                dataKey="date"
                stroke="#666666"
                tick={{ fontSize: 10, fontFamily: "Space Mono, monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#666666", strokeOpacity: 0.3 }}
                minTickGap={24}
              />
              <YAxis
                stroke="#666666"
                tick={{ fontSize: 10, fontFamily: "Space Mono, monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#666666", strokeOpacity: 0.3 }}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "#0D0D0D",
                  border: "1px solid #666666",
                  fontFamily: "Space Mono, monospace",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                }}
                itemStyle={{ padding: 0 }}
                labelStyle={{ color: "#FF3300", textTransform: "uppercase" }}
              />
              <Legend
                wrapperStyle={{
                  fontSize: 10,
                  fontFamily: "Space Mono, monospace",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                }}
              />
              {(Object.keys(visible) as StatusKey[]).map((k) =>
                visible[k] ? (
                  <Line
                    key={k}
                    type="monotone"
                    dataKey={k}
                    name={k.toUpperCase()}
                    stroke={STATUS_COLORS[k]}
                    strokeWidth={k === "available" ? 2.5 : 1.2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${m}/${d}`;
}
