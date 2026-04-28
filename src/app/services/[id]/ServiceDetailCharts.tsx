"use client";

import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export type ScorePoint = {
  t: string;
  total: number;
  completion: number;
  speed: number;
  drop: number;
  cost: number;
};

type SeriesKey = "total" | "completion" | "speed" | "drop" | "cost";

const SERIES: Array<{
  key: SeriesKey;
  label: string;
  color: string;
  width: number;
}> = [
  { key: "total", label: "Total", color: "#FFFFFF", width: 2.5 },
  { key: "completion", label: "Livraison", color: "#999999", width: 1.2 },
  { key: "speed", label: "Vitesse", color: "#777777", width: 1.2 },
  { key: "drop", label: "Drop", color: "#555555", width: 1.2 },
  { key: "cost", label: "Coût", color: "#333333", width: 1.2 },
];

function formatTick(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}/${day} ${String(d.getUTCHours()).padStart(2, "0")}H`;
}

type TooltipPayload = {
  name: string;
  value: number;
  color: string;
  dataKey: string;
};

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="bg-[#030303] border border-[#FF3300] p-3 font-mono text-xs">
      <div className="text-[#666666] tracking-widest uppercase mb-2">
        {new Date(label).toLocaleString("fr-FR")}
      </div>
      {payload.map((p) => (
        <div
          key={p.dataKey}
          className="flex items-center justify-between gap-6 tabular-nums"
        >
          <span style={{ color: p.color }} className="uppercase tracking-widest">
            {p.name}
          </span>
          <span className="text-white">{p.value.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

export function ServiceDetailCharts({ points }: { points: ScorePoint[] }) {
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    total: true,
    completion: true,
    speed: true,
    drop: true,
    cost: true,
  });

  function toggle(key: SeriesKey) {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-6">
        {SERIES.map((s) => {
          const active = visible[s.key];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={`interactive font-mono text-xs tracking-widest uppercase px-3 py-1.5 border transition-colors ${
                active
                  ? "bg-[#FF3300] text-black border-[#FF3300]"
                  : "bg-transparent text-[#666666] border-[#666666]/30 hover:text-white hover:border-white"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div style={{ width: "100%", height: 360 }}>
        <ResponsiveContainer>
          <LineChart
            data={points}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#666666"
              strokeOpacity={0.2}
            />
            <XAxis
              dataKey="t"
              tickFormatter={formatTick}
              tick={{ fontSize: 10, fill: "#666666", fontFamily: "var(--font-mono-stack)" }}
              minTickGap={50}
              stroke="#666666"
              strokeOpacity={0.3}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: "#666666", fontFamily: "var(--font-mono-stack)" }}
              width={32}
              stroke="#666666"
              strokeOpacity={0.3}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ stroke: "#FF3300", strokeOpacity: 0.4, strokeWidth: 1 }}
            />
            {SERIES.filter((s) => visible[s.key]).map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={s.width}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
