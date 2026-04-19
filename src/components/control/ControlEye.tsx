"use client";

import { useId, type CSSProperties } from "react";

type Props = {
  size?: number;
  hDelay?: number;
  vDelay?: number;
  active?: boolean;
  className?: string;
};

export function ControlEye({
  size = 48,
  hDelay = 0,
  vDelay = 0,
  active = false,
  className = "",
}: Props) {
  const rawId = useId();
  const clipId = `ce-clip-${rawId.replace(/[:]/g, "")}`;
  const strokeTop = size < 30 ? 1.1 : size < 50 ? 0.9 : 0.7;
  const strokeBot = size < 30 ? 0.8 : size < 50 ? 0.6 : 0.5;

  const style = {
    "--h-delay": `${hDelay}s`,
    "--v-delay": `${vDelay}s`,
  } as CSSProperties;

  return (
    <svg
      className={`control-eye ${active ? "is-active" : ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={style}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M 3,17 Q 16,11 29,17 Q 16,25 3,17 Z" />
        </clipPath>
      </defs>
      <path d="M 3,17 Q 16,11 29,17 Q 16,25 3,17 Z" fill="#FFFFFF" />
      <g clipPath={`url(#${clipId})`}>
        <g className="look-h">
          <g className="look-v">
            <circle className="iris" cx="16" cy="19" r="5" fill="#FF3300" />
            <circle className="pupil" cx="16" cy="19" r="2" fill="#030303" />
          </g>
        </g>
        <rect
          className="lid"
          x="0"
          y="0"
          width="32"
          height="17"
          fill="#666666"
        />
      </g>
      <path
        d="M 3,17 Q 16,17 29,17"
        fill="none"
        stroke="#030303"
        strokeWidth={strokeTop}
        strokeLinecap="square"
      />
      <path
        d="M 3,17 Q 16,25 29,17"
        fill="none"
        stroke="#666666"
        strokeWidth={strokeBot}
        strokeLinecap="square"
      />
    </svg>
  );
}
