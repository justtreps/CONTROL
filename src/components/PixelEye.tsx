"use client";

import { useEffect, useState } from "react";
import { useActivity } from "./ActivityContext";

type Props = {
  watching?: boolean;
  size?: number;
  className?: string;
};

const POSITIONS: Array<[number, number]> = [
  [0, 0],
  [2, 0],
  [-2, 0],
  [0, -2],
  [2, -2],
  [-2, -2],
];

const SCAN_INTERVAL_MS = 1200;
const ACTIVITY_INTERVAL_MS = 400;
const ACTIVITY_DURATION_MS = 1200;

export function PixelEye({ watching = false, size = 32, className = "" }: Props) {
  const [posIndex, setPosIndex] = useState(0);
  const [activity, setActivity] = useState(false);
  const [reduced, setReduced] = useState(false);
  const { flashTick } = useActivity();

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (flashTick === 0) return;
    setActivity(true);
    const t = setTimeout(() => setActivity(false), ACTIVITY_DURATION_MS);
    return () => clearTimeout(t);
  }, [flashTick]);

  useEffect(() => {
    if (reduced || watching) return;
    const interval = activity ? ACTIVITY_INTERVAL_MS : SCAN_INTERVAL_MS;
    const id = setInterval(() => {
      setPosIndex((p) => (p + 1) % POSITIONS.length);
    }, interval);
    return () => clearInterval(id);
  }, [reduced, watching, activity]);

  let dx = 0;
  let dy = 0;
  if (watching) {
    dx = -2;
    dy = 1;
  } else if (!reduced) {
    [dx, dy] = POSITIONS[posIndex];
  }

  const filter = activity
    ? "brightness(1.3) drop-shadow(0 0 1px #FF3300)"
    : "none";

  return (
    <svg
      className={`pixel-eye ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {/* Sclera — white pixel oval, rows 4-11 */}
      <rect x="5" y="4" width="6" height="1" fill="#FFFFFF" />
      <rect x="3" y="5" width="10" height="1" fill="#FFFFFF" />
      <rect x="2" y="6" width="12" height="4" fill="#FFFFFF" />
      <rect x="3" y="10" width="10" height="1" fill="#FFFFFF" />
      <rect x="5" y="11" width="6" height="1" fill="#FFFFFF" />

      {/* Iris 4x4 red + pupille 2x2 noire + reflet 1x1 blanc */}
      <g
        className="pixel-iris"
        style={{
          transform: `translate(${dx}px, ${dy}px)`,
          filter,
        }}
      >
        <rect x="6" y="6" width="4" height="4" fill="#FF3300" />
        <rect x="7" y="7" width="2" height="2" fill="#000000" />
        <rect x="6" y="6" width="1" height="1" fill="#FFFFFF" />
      </g>
    </svg>
  );
}
