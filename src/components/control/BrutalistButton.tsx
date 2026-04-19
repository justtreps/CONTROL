"use client";

import type { ReactNode, MouseEventHandler } from "react";

type Variant = "default" | "primary" | "danger" | "ghost";

export function BrutalistButton({
  children,
  variant = "default",
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  variant?: Variant;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} interactive ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
