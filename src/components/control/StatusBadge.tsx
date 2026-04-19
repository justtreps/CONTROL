type Variant = "default" | "active" | "warn" | "danger";

export function StatusBadge({
  label,
  variant = "default",
}: {
  label: string;
  variant?: Variant;
}) {
  return <span className={`status-badge status-badge--${variant}`}>{label}</span>;
}
