"use client";

import { useState, type ReactNode } from "react";

// Generic brutalist [ ▸ LABEL ] / [ ▾ LABEL ] toggle used throughout /pool.
// Keeps layout consistent across accordions and outer zones.
type Props = {
  label: string;
  hint?: string;
  defaultOpen?: boolean;
  /** When true the button stretches across the section with a bg like a banner. */
  banner?: boolean;
  /** When true the header is compact (used for inner accordions). */
  compact?: boolean;
  children: ReactNode;
};

export function Collapsible({
  label,
  hint,
  defaultOpen = false,
  banner = false,
  compact = false,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (banner) {
    return (
      <section className="w-full">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="interactive w-full font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-4 border-y border-[#666666]/20 bg-[#0D0D0D] hover:bg-[#141414] hover:text-white transition-colors flex items-center justify-between gap-3"
        >
          <span>{open ? `[ ▾ ${label} ]` : `[ ▸ ${label} ]`}</span>
          {hint && (
            <span className="hidden sm:inline text-[10px] text-[#666666]/70 truncate max-w-[50%]">
              {hint}
            </span>
          )}
        </button>
        {open && <div>{children}</div>}
      </section>
    );
  }

  return (
    <div className={`w-full ${compact ? "" : "border border-[#666666]/30"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`interactive w-full flex items-center justify-between gap-3 font-mono text-xs tracking-widest uppercase transition-colors ${
          compact
            ? "px-4 py-3 border-b border-[#666666]/20 bg-[#0D0D0D]/60 hover:bg-[#141414] text-[#666666] hover:text-white"
            : "px-4 md:px-6 py-3 md:py-4 text-white hover:bg-[#0D0D0D]"
        } ${open && !compact ? "border-b border-[#666666]/30" : ""}`}
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className={compact ? "" : "text-[#FF3300]"}>
            {open ? "▾" : "▸"}
          </span>
          <span className="truncate">{label}</span>
        </span>
        {hint && (
          <span className="hidden sm:inline text-[10px] text-[#666666]/70 truncate max-w-[50%] normal-case">
            {hint}
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}
