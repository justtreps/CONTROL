import type { CSSProperties } from "react";

// Brutalist skeleton — a flat bar with a slow red-tinted pulse, used
// wherever we used to show the word "CHARGEMENT...". The pulse respects
// prefers-reduced-motion via the global rule in globals.css.
export function Skeleton({
  className = "",
  width,
  height,
  style,
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`animate-skeleton-pulse bg-[#0D0D0D] border border-[#666666]/20 ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

// One table row of skeletons — used inside <tbody> to mirror the real
// row shape so the layout doesn't jump when real data arrives.
export function SkeletonRow({
  cols,
  compact = false,
}: {
  cols: number;
  compact?: boolean;
}) {
  return (
    <tr className="border-b border-[#666666]/20">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className={compact ? "px-3 py-2" : "px-3 py-3"}>
          <Skeleton height={compact ? 10 : 14} className="w-full max-w-[10rem]" />
        </td>
      ))}
    </tr>
  );
}
