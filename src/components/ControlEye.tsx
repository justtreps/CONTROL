"use client";

import { useEffect, useRef, useState } from "react";
import { useActivity } from "./ActivityContext";

type Props = {
  watching?: boolean;
  size?: number;
  className?: string;
};

const MAX_OFFSET = 5;
const ACTIVITY_DURATION_MS = 1200;

export function ControlEye({ watching = false, size = 32, className = "" }: Props) {
  const [dx, setDx] = useState(0);
  const [blinking, setBlinking] = useState(false);
  const [activity, setActivity] = useState(false);
  const [reduced, setReduced] = useState(false);
  const { flashTick } = useActivity();
  const scanStartRef = useRef<number | null>(null);

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
    if (reduced) {
      setDx(0);
      return;
    }
    if (watching) {
      setDx(-4);
      return;
    }

    let frame: number;
    scanStartRef.current = performance.now();

    const tick = (now: number) => {
      const t = (now - (scanStartRef.current ?? now)) / 1000;
      const cyclesPerSec = activity ? 1.25 : 1 / 6;
      const phase = t * cyclesPerSec * Math.PI * 2;
      const dither = Math.sin(phase * 3.7) * 0.4;
      setDx(Math.sin(phase) * MAX_OFFSET + dither);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [watching, activity, reduced]);

  useEffect(() => {
    if (reduced || watching) return;
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let nextTimer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const delay = 4000 + Math.random() * 3000;
      nextTimer = setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        closeTimer = setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          schedule();
        }, 120);
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (nextTimer) clearTimeout(nextTimer);
    };
  }, [reduced, watching]);

  const irisFill = activity ? "#FF6644" : "#FF3300";
  const filter = activity
    ? "drop-shadow(0 0 4px rgba(255, 51, 0, 0.95))"
    : "none";
  const lidScale = blinking ? 0.08 : 1;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ overflow: "visible", display: "block" }}
    >
      <defs>
        <clipPath id="control-eye-clip">
          <ellipse cx="16" cy="16" rx="14" ry="8" />
        </clipPath>
      </defs>

      <g
        style={{
          transform: `scaleY(${lidScale})`,
          transformBox: "fill-box",
          transformOrigin: "center",
          transition: "transform 80ms ease-out",
        }}
      >
        <ellipse
          cx="16"
          cy="16"
          rx="14"
          ry="8"
          fill="#000"
          stroke="#FFFFFF"
          strokeWidth="1"
        />
        <g clipPath="url(#control-eye-clip)" style={{ filter }}>
          <g
            style={{ transition: "transform 120ms ease-out" }}
            transform={`translate(${dx.toFixed(2)} ${watching ? 2 : 0})`}
          >
            <circle cx="16" cy="16" r="4" fill={irisFill} />
            <circle cx="16" cy="16" r="1.5" fill="#000" />
            <circle cx="14.8" cy="14.8" r="0.7" fill="#FFFFFF" />
          </g>
        </g>
      </g>
    </svg>
  );
}
