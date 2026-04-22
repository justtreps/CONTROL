"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";

export type ActivePool = "follower" | "engagement";

type Props = {
  activePool: ActivePool;
  // Current count + target for each pool. Computed server-side from
  // TestAccount rows and PoolConfig so the two buttons always show
  // live numbers without a second fetch on the client.
  followerCount: number;
  followerTarget: number;
  engagementCount: number;
  engagementTarget: number;
};

// Dominant top-of-page navigation for /pool. Two symmetric buttons,
// brutalist outline/filled states, URL persistence via ?type=...
//
// Loading behaviour: clicking a button drops CONTROL's iron-curtain
// (same idiom as the scrape / health-check actions) so the user gets
// an unmistakable signal that the switch is working. We call show()
// on click and hide() once useTransition reports isPending=false —
// meaning the server re-render finished and the new pool's content
// has streamed in. LoadingContext enforces a 800ms minimum visible
// time so the curtain never flickers even on fast hops.
export function PoolUniverseSwitch({
  activePool,
  followerCount,
  followerTarget,
  engagementCount,
  engagementTarget,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { show, hide } = useLoading();
  const curtainOpenRef = useRef(false);

  function go(pool: ActivePool) {
    if (pool === activePool) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("type", pool === "follower" ? "followers" : "engagement");
    curtainOpenRef.current = true;
    show();
    startTransition(() => {
      router.push(`/pool?${params.toString()}`);
    });
  }

  // Close the curtain once the server render landed. We track state
  // via a ref so hide() isn't fired on mount — only after a real
  // transition. The LoadingContext dedupes the 800ms minimum so the
  // curtain always feels deliberate.
  useEffect(() => {
    if (!isPending && curtainOpenRef.current) {
      curtainOpenRef.current = false;
      hide();
    }
  }, [isPending, hide]);

  return (
    <section className="px-4 md:px-8 pt-24 md:pt-28 pb-4 md:pb-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        <UniverseButton
          label="ABONNÉS"
          sublabel={`POOL ${followerCount.toLocaleString("en-US")} / ${followerTarget.toLocaleString("en-US")}`}
          active={activePool === "follower"}
          onClick={() => go("follower")}
        />
        <UniverseButton
          label="ENGAGEMENT"
          sublabel={`POOL ${engagementCount.toLocaleString("en-US")} / ${engagementTarget.toLocaleString("en-US")}`}
          active={activePool === "engagement"}
          onClick={() => go("engagement")}
        />
      </div>
    </section>
  );
}

function UniverseButton({
  label,
  sublabel,
  active,
  onClick,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`interactive group relative border-2 py-8 md:py-10 px-6 md:px-10 flex flex-col items-start gap-2 text-left transition-colors duration-150 ${
        active
          ? "border-[#FF3300] bg-[#FF3300] text-black"
          : "border-[#666666]/50 bg-transparent text-white hover:border-white"
      }`}
    >
      <span
        className={`font-mono text-[10px] tracking-[0.25em] uppercase ${
          active ? "text-black/70" : "text-[#666666]"
        }`}
      >
        [ {active ? "ACTIF" : "SÉLECTIONNER"} ]
      </span>
      <span
        className="brand font-display uppercase tracking-tight leading-none break-words"
        style={{ fontSize: "clamp(2.25rem, 5.5vw, 4rem)" }}
      >
        {label}.
      </span>
      <span
        className={`font-mono text-[11px] tracking-[0.2em] uppercase tabular-nums ${
          active ? "text-black/80" : "text-[#666666]"
        }`}
      >
        {sublabel}
      </span>
    </button>
  );
}
