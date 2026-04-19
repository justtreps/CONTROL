"use client";

import { useEffect, useState } from "react";
import { useLoading } from "./LoadingContext";
import { ControlEye } from "./control";

type Phase = "hidden" | "closing" | "stase" | "opening";

const SLAM_MS = 380;
const OPEN_MS = 600;

export function LoadingScreen() {
  const { visible } = useLoading();
  const [phase, setPhase] = useState<Phase>("hidden");

  useEffect(() => {
    if (visible && (phase === "hidden" || phase === "opening")) {
      setPhase("closing");
      return;
    }
    if (!visible && (phase === "closing" || phase === "stase")) {
      setPhase("opening");
      return;
    }
  }, [visible, phase]);

  useEffect(() => {
    if (phase === "closing") {
      const t = setTimeout(() => setPhase("stase"), SLAM_MS);
      return () => clearTimeout(t);
    }
    if (phase === "opening") {
      const t = setTimeout(() => setPhase("hidden"), OPEN_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const contentVisible = phase === "stase";

  let curtainClass = "";
  if (phase === "hidden") curtainClass = "-translate-y-full";
  else if (phase === "closing") curtainClass = "curtain-slam";
  else if (phase === "stase") curtainClass = "translate-y-0";
  else if (phase === "opening")
    curtainClass = `-translate-y-full transition-transform duration-[${OPEN_MS}ms] ease-[cubic-bezier(0.77,0,0.175,1)]`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-cursor="invert"
      className={`fixed inset-0 z-[10000] overflow-hidden ${
        phase === "hidden" ? "pointer-events-none" : ""
      }`}
      aria-hidden={phase === "hidden"}
    >
      {/* Iron curtain — slams down via keyframe with overshoot, retracts smooth */}
      <div className={`absolute inset-0 iron-curtain-panel ${curtainClass}`}>
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center text-black px-6 transition-opacity duration-150 ${
            contentVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="font-mono text-xs tracking-widest border border-black/30 px-4 py-1 mb-10">
            [ NŒUD TERMINAL | CHARGEMENT ]
          </div>

          <ControlEye size={140} className="mb-6" />

          <h1 className="brand font-display uppercase tracking-tight leading-[0.85] m-0 text-center text-fluid-title">
            CONTROL.
          </h1>

          <div className="flex flex-col items-center gap-3 mt-12">
            <div className="font-mono text-xs tracking-widest">
              PAR MY HUB SOLUTIONS
            </div>
            <div className="w-64 h-[1px] bg-black/30 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0 bg-black loading-bar" />
            </div>
          </div>
        </div>
      </div>

      <span className="sr-only">Chargement de CONTROL.</span>
    </div>
  );
}
