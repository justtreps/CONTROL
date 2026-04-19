"use client";

import { useLoading } from "./LoadingContext";

export function LoadingScreen() {
  const { visible } = useLoading();
  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-cursor="invert"
      className="fixed inset-0 z-[10000] bg-[#FF3300] text-black flex flex-col items-center justify-center animate-loading-fade-in"
    >
      <div className="flex flex-col items-center justify-center w-full h-full gap-12 relative px-6">
        <div className="font-mono text-xs tracking-widest border border-black/30 px-4 py-1">
          [ TERMINAL NODE | LOADING ]
        </div>

        <h1 className="brand font-display uppercase tracking-tight leading-[0.85] m-0 text-center text-fluid-title">
          CONTROL.
        </h1>

        <div className="flex flex-col items-center gap-3 mt-8">
          <div className="font-mono text-xs tracking-widest">
            BY MY HUB SOLUTIONS
          </div>
          <div className="w-64 h-[1px] bg-black/30 overflow-hidden relative">
            <div className="absolute inset-y-0 left-0 bg-black loading-bar" />
          </div>
        </div>
      </div>
      <span className="sr-only">CONTROL loading.</span>
    </div>
  );
}
