"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SCOPE, type PlatformCfg, type ServiceTypeCfg } from "@/lib/scope";

type Props = {
  activePlatform: string;
  activeType: string;
};

export function ServicesNav({ activePlatform, activeType }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const currentPlatform =
    SCOPE.platforms.find((p) => p.id === activePlatform) ?? SCOPE.platforms[0];

  function go(platform: string, type: string) {
    startTransition(() => {
      router.push(`/services?platform=${platform}&type=${type}`);
    });
  }

  function onPlatformClick(p: PlatformCfg) {
    if (!p.enabled) return;
    const firstMvpType = p.types.find((t) => t.mvp) ?? p.types[0];
    go(p.id, firstMvpType.id);
  }

  function onTypeClick(t: ServiceTypeCfg) {
    if (!t.mvp) return;
    go(currentPlatform.id, t.id);
  }

  return (
    <div
      className={`border-y border-[#666666]/20 bg-[#0D0D0D] ${
        pending ? "opacity-60" : ""
      }`}
    >
      {/* Platform tabs */}
      <div className="flex flex-wrap gap-0 border-b border-[#666666]/20">
        {SCOPE.platforms.map((p) => {
          const active = p.id === currentPlatform.id;
          if (!p.enabled) {
            return (
              <div
                key={p.id}
                className="px-4 md:px-6 py-3 font-mono text-[11px] tracking-[0.2em] uppercase text-[#666666]/50 border-r border-[#666666]/20 flex items-center gap-2 cursor-not-allowed"
                title="Plateforme pas encore activée"
              >
                {p.label}
                <span className="text-[9px] text-[#666666]">[ SOON ]</span>
              </div>
            );
          }
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPlatformClick(p)}
              className={`interactive px-4 md:px-6 py-3 font-mono text-[11px] tracking-[0.2em] uppercase border-r border-[#666666]/20 transition-colors ${
                active
                  ? "bg-[#FF3300] text-black"
                  : "text-[#666666] hover:text-white"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Type chips for the active platform */}
      <div className="flex flex-wrap items-center gap-4 md:gap-6 px-4 md:px-6 py-3">
        {currentPlatform.types.map((t) => {
          const active = t.id === activeType;
          if (!t.mvp) {
            return (
              <div
                key={t.id}
                className="font-mono text-[11px] tracking-[0.2em] uppercase text-[#666666]/50 flex items-center gap-2 cursor-not-allowed"
                title="Service pas encore actif"
              >
                {t.label}
                <span className="text-[9px] text-[#666666]">[ SOON ]</span>
              </div>
            );
          }
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTypeClick(t)}
              className={`interactive font-mono text-[11px] tracking-[0.2em] uppercase transition-colors relative ${
                active
                  ? "text-white"
                  : "text-[#666666] hover:text-white"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute left-0 right-0 -bottom-3 h-[2px] bg-[#FF3300]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
