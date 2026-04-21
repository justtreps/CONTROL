"use client";

import { Collapsible } from "./Collapsible";
import { PoolSeedsCard } from "./PoolSeedsCard";
import { PoolSettings } from "./PoolSettings";

type Cfg = React.ComponentProps<typeof PoolSettings>["initialConfig"];

// Zone 4 — advanced config wrapper. Collapsed by default so the main
// page stays focused on everyday tasks. Inside, 2 sub-sections:
//   A. COMPTES SOURCES — big-account seeds (Method A)
//   B. PARAMÈTRES TECHNIQUES — auto-refill / quotas / cron / quality
// Method B (username-prefix random scraping) is no longer surfaced
// here since we've decided not to use it.
export function PoolAdvancedConfig({ initialConfig }: { initialConfig: Cfg }) {
  return (
    <Collapsible
      banner
      label="CONFIGURATION AVANCÉE"
      hint="pour régler finement le scrape · à laisser fermé en usage normal"
    >
      {/* Sub-section A — Seeds (Method A) */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">A.</span>
          <span className="text-white">COMPTES SOURCES</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (&laquo;&nbsp;big accounts&nbsp;&raquo; dans les followers desquels on cherche nos
            comptes test)
          </span>
        </div>
        <PoolSeedsCard />
      </div>

      {/* Sub-section B — Technical settings */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">B.</span>
          <span className="text-white">PARAMÈTRES TECHNIQUES</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (auto-refill, quotas API, cron, critères de qualité)
          </span>
        </div>
        <PoolSettings initialConfig={initialConfig} />
      </div>
    </Collapsible>
  );
}
