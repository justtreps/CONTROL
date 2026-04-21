"use client";

import { Collapsible } from "./Collapsible";
import { PoolSeedsCard } from "./PoolSeedsCard";
import { PoolPrefixesCard } from "./PoolPrefixesCard";
import { PoolSettings } from "./PoolSettings";

type Cfg = React.ComponentProps<typeof PoolSettings>["initialConfig"];

// Zone 4 — advanced config wrapper. Collapsed by default so the main
// page stays focused on everyday tasks. Inside, 3 sub-sections grouped
// by concept: sources (seeds), random fallback (prefixes), technical
// settings (the old Settings card).
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
            (&laquo;&nbsp;big accounts&nbsp;&raquo; dans la followers desquels on cherche nos
            comptes test)
          </span>
        </div>
        <PoolSeedsCard />
      </div>

      {/* Sub-section B — Prefixes (Method B) */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">B.</span>
          <span className="text-white">MÉTHODE ALTERNATIVE</span>
          <span className="normal-case text-[#666666]/70 text-[10px]">
            (générateur de usernames random à partir de préfixes)
          </span>
        </div>
        <PoolPrefixesCard />
      </div>

      {/* Sub-section C — Technical settings */}
      <div className="w-full">
        <div className="font-mono text-xs text-[#666666] tracking-widest px-4 md:px-8 py-3 border-b border-[#666666]/20 bg-[#030303] flex items-center gap-3 flex-wrap">
          <span className="text-[#FF3300]">C.</span>
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
