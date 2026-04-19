type Variant = "default" | "warn";

export function SegmentedBar({
  value = 75,
  segments = 20,
  label,
  variant = "default",
}: {
  value?: number;
  segments?: number;
  label?: string;
  variant?: Variant;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  const filled = Math.round((clamped / 100) * segments);
  const cellClass = variant === "warn" ? "is-warn" : "";

  return (
    <div className="seg-bar">
      {label && (
        <div className="seg-header">
          <span>{label}</span>
          <span className="seg-value">{clamped}%</span>
        </div>
      )}
      <div className="seg-track">
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className={`seg-cell ${i < filled ? "is-filled" : ""} ${cellClass}`}
          />
        ))}
      </div>
    </div>
  );
}
