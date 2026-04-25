import { ControlEye } from "./ControlEye";
import { ControlRadar } from "./ControlRadar";

type Size = "sm" | "md" | "lg";
type Variant = "eye" | "radar";

const SIZES: Record<Size, { icon: number; font: number }> = {
  sm: { icon: 20, font: 13 },
  md: { icon: 28, font: 16 },
  lg: { icon: 40, font: 22 },
};

export function ControlLogo({
  size = "md",
  variant = "eye",
  className = "",
}: {
  size?: Size;
  variant?: Variant;
  className?: string;
}) {
  const cfg = SIZES[size];
  const Icon = variant === "radar" ? ControlRadar : ControlEye;
  return (
    <div className={`control-logo ${className}`}>
      <Icon size={cfg.icon} />
      <span className="wordmark" style={{ fontSize: cfg.font }}>
        CONTROL
      </span>
    </div>
  );
}
