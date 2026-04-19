type Variant = "active" | "idle" | "error" | "warn";

export function StatusDot({
  variant = "active",
  pulsing = true,
}: {
  variant?: Variant;
  pulsing?: boolean;
}) {
  return (
    <span
      className={`status-dot status-dot--${variant} ${pulsing ? "is-pulsing" : ""}`}
      aria-hidden="true"
    />
  );
}
