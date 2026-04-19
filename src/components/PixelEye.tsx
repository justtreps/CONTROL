"use client";

import { useEffect, useState } from "react";
import { useActivity } from "./ActivityContext";

type Props = {
  watching?: boolean;
  size?: number;
  className?: string;
};

const ACTIVITY_DURATION_MS = 1200;
const BLINK_DURATION_MS = 200;

export function PixelEye({ watching = false, size = 32, className = "" }: Props) {
  const [blinking, setBlinking] = useState(false);
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
    let cancelled = false;
    let lidTimer: ReturnType<typeof setTimeout> | undefined;
    let nextTimer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const delay = 4000 + Math.random() * 3000;
      nextTimer = setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        lidTimer = setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          schedule();
        }, BLINK_DURATION_MS);
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (nextTimer) clearTimeout(nextTimer);
      if (lidTimer) clearTimeout(lidTimer);
    };
  }, [reduced, watching]);

  const irisClass = [
    "pixel-iris",
    reduced ? "reduced" : watching ? "watching" : "scanning",
    activity ? "activity" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
      <g className={irisClass}>
        <rect x="6" y="6" width="4" height="4" fill="#FF3300" />
        <rect x="7" y="7" width="2" height="2" fill="#000000" />
        <rect x="6" y="6" width="1" height="1" fill="#FFFFFF" />
      </g>

      {/* Eyelid overlay during blink */}
      <rect
        className={`pixel-lid ${blinking ? "blink" : ""}`}
        x="2"
        y="4"
        width="12"
        height="8"
        fill="#000000"
      />
    </svg>
  );
}
