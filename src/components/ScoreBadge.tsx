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
      <span className="inline-flex items-center rounded-md bg-neutral-100 text-neutral-500 px-2 py-1 text-xs">
        —
      </span>
    );
  }
  const tier = scoreTier(score);
  const tierClasses =
    tier === "good"
      ? "bg-green-100 text-green-800"
      : tier === "warn"
        ? "bg-orange-100 text-orange-800"
        : "bg-red-100 text-red-800";
  const sizeClasses = size === "sm" ? "text-xs px-1.5 py-0.5" : "text-sm px-2 py-1 font-medium";
  return (
    <span className={`inline-flex items-center rounded-md ${tierClasses} ${sizeClasses}`}>
      {score.toFixed(0)}
    </span>
  );
}
