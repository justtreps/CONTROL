"use client";

import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

export type ScorePoint = {
  t: string;
  total: number;
  completion: number;
  realism: number;
  speed: number;
  drop: number;
};

type SeriesKey = "total" | "completion" | "realism" | "speed" | "drop";

const SERIES: Array<{ key: SeriesKey; label: string; color: string }> = [
  { key: "total", label: "Score total", color: "#171717" },
  { key: "completion", label: "Livraison", color: "#2563eb" },
  { key: "realism", label: "Réalisme", color: "#16a34a" },
  { key: "speed", label: "Vitesse", color: "#c2410c" },
  { key: "drop", label: "Drop", color: "#a21caf" },
];

function formatTick(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}h`;
}

export function ServiceDetailCharts({ points }: { points: ScorePoint[] }) {
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    total: true,
    completion: true,
    realism: true,
    speed: true,
    drop: true,
  });

  function toggle(key: SeriesKey) {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-4">
        {SERIES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => toggle(s.key)}
            className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-2 ${
              visible[s.key]
                ? "bg-white border-neutral-300"
                : "bg-neutral-100 border-neutral-200 text-neutral-400"
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: visible[s.key] ? s.color : "#d4d4d4" }}
            />
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={points} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
            <XAxis
              dataKey="t"
              tickFormatter={formatTick}
              tick={{ fontSize: 11, fill: "#737373" }}
              minTickGap={40}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 11, fill: "#737373" }}
              width={30}
            />
            <Tooltip
              labelFormatter={(v) => new Date(v as string).toLocaleString()}
              contentStyle={{ fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {SERIES.filter((s) => visible[s.key]).map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={s.key === "total" ? 2.5 : 1.5}
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
