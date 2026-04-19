export function scoreTier(score: number): "good" | "warn" | "bad" {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

export function ScoreBadge({
  score,
  size = "md",
}: {
  score: number | null;
  size?: "sm" | "md";
}) {
  if (score === null || Number.isNaN(score)) {
    return (
      <span className="font-mono text-[#666666] tabular-nums uppercase tracking-widest text-xs">
        —
      </span>
    );
  }

  const tier = scoreTier(score);
  const value = score.toFixed(0);
  const sizeClass = size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-3 py-1";

  if (tier === "good") {
    return (
      <span
        className={`inline-flex items-center justify-center font-mono tabular-nums tracking-widest bg-[#FF3300] text-black font-bold ${sizeClass}`}
      >
        {value}
      </span>
    );
  }

  const color = tier === "warn" ? "text-[#FFCC00]" : "text-[#FF3300]";
  return (
    <span
      className={`font-mono tabular-nums tracking-widest uppercase ${color} ${
        size === "sm" ? "text-xs" : "text-sm"
      }`}
    >
      {value}
    </span>
  );
}
