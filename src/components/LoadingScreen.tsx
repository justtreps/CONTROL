"use client";

import { useEffect, useState } from "react";
import { useLoading } from "./LoadingContext";

type Phase = "hidden" | "closing" | "stase" | "opening";

const CURTAIN_MS = 600;

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
      const t = setTimeout(() => setPhase("stase"), CURTAIN_MS);
      return () => clearTimeout(t);
    }
    if (phase === "opening") {
      const t = setTimeout(() => setPhase("hidden"), CURTAIN_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const closed = phase === "closing" || phase === "stase";
  const contentVisible = phase === "stase";

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
      {/* Top curtain — slides down from above */}
      <div
        className={`absolute top-0 inset-x-0 h-[51vh] iron-curtain-panel transition-transform duration-[600ms] ease-[cubic-bezier(0.77,0,0.175,1)] will-change-transform ${
          closed ? "translate-y-0" : "-translate-y-full"
        }`}
      />

      {/* Bottom curtain — slides up from below */}
      <div
        className={`absolute bottom-0 inset-x-0 h-[51vh] iron-curtain-panel transition-transform duration-[600ms] ease-[cubic-bezier(0.77,0,0.175,1)] will-change-transform ${
          closed ? "translate-y-0" : "translate-y-full"
        }`}
      />

      {/* Content overlay — only opaque during stase */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center text-black px-6 transition-opacity duration-200 ${
          contentVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="font-mono text-xs tracking-widest border border-black/30 px-4 py-1 mb-12">
          [ NŒUD TERMINAL | CHARGEMENT ]
        </div>

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

      <span className="sr-only">Chargement de CONTROL.</span>
    </div>
  );
}
