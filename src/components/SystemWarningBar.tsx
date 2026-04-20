"use client";

// Global warning strip — renders above the nav whenever ≥1 system
// toggle is off. Polls /api/system/toggles every 30s. Clicking the
// bar jumps to /pool#kill-switch. Hidden entirely when everything is
// enabled so the happy-path UI isn't cluttered.

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type Toggles = {
  poolScrapeEnabled: boolean;
  poolHealthcheckEnabled: boolean;
  routingApiEnabled: boolean;
  testBotEnabled: boolean;
  scoringEngineEnabled: boolean;
};

const KEYS: Array<keyof Toggles> = [
  "poolScrapeEnabled",
  "poolHealthcheckEnabled",
  "routingApiEnabled",
  "testBotEnabled",
  "scoringEngineEnabled",
];

const LABELS: Record<keyof Toggles, string> = {
  poolScrapeEnabled: "POOL SCRAPE",
  poolHealthcheckEnabled: "POOL HEALTHCHECK",
  routingApiEnabled: "ROUTING",
  testBotEnabled: "TEST BOT",
  scoringEngineEnabled: "SCORING",
};

export function SystemWarningBar() {
  const pathname = usePathname();
  const [toggles, setToggles] = useState<Toggles | null>(null);

  useEffect(() => {
    if (pathname === "/login") return; // never fetch when unauthenticated
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/system/toggles", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { toggles: Toggles };
        if (!cancelled) setToggles(d.toggles);
      } catch {
        /* swallow */
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pathname]);

  if (!toggles || pathname === "/login") return null;

  const disabled = KEYS.filter((k) => !toggles[k]);
  if (disabled.length === 0) return null;

  const labels = disabled.map((k) => LABELS[k]).join(" · ");

  return (
    <Link
      href="/pool#kill-switch"
      className="interactive block w-full bg-[#FF3300] text-black border-b-2 border-black"
      data-cursor="invert"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 px-4 md:px-6 py-2 font-mono text-[11px] tracking-widest uppercase">
        <span className="flex items-center gap-2 truncate">
          <span className="font-bold">[ SYSTEM WARNING ]</span>
          <span className="hidden sm:inline truncate">
            {disabled.length} SYSTEM{disabled.length > 1 ? "S" : ""} PAUSED · {labels}
          </span>
          <span className="sm:hidden">
            {disabled.length} PAUSED
          </span>
        </span>
        <span className="flex-shrink-0 border border-black px-2 py-0.5">
          [ SEE STATUS → ]
        </span>
      </div>
    </Link>
  );
}
