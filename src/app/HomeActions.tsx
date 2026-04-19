"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLoading } from "@/components/LoadingContext";
import { useActivity } from "@/components/ActivityContext";

type ActionButtonProps = {
  endpoint: string;
  labelIdle: string;
  labelRunning: string;
  variant?: "dark" | "danger";
};

function ActionButton({
  endpoint,
  labelIdle,
  labelRunning,
  variant = "dark",
}: ActionButtonProps) {
  const router = useRouter();
  const { show, hide } = useLoading();
  const { flash } = useActivity();
  const [running, setRunning] = useState(false);

  async function trigger() {
    if (running) return;
    setRunning(true);
    show();
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) flash();
      router.refresh();
    } finally {
      setTimeout(() => {
        hide();
        setRunning(false);
      }, 600);
    }
  }

  if (variant === "danger") {
    return (
      <button
        type="button"
        onClick={trigger}
        disabled={running}
        className="interactive font-mono text-sm tracking-widest border border-black px-12 py-4 hover:bg-black hover:text-[#FF3300] transition-colors duration-300 disabled:opacity-60"
      >
        {running ? labelRunning : labelIdle}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={trigger}
      disabled={running}
      className="interactive group relative w-full border border-[#666666]/30 bg-[#0D0D0D] py-4 px-6 overflow-hidden flex justify-between items-center text-left disabled:opacity-60"
    >
      <div className="absolute inset-0 bg-[#FF3300] transform translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out z-0" />
      <span className="relative font-mono text-xs tracking-widest text-white z-10 group-hover:text-black transition-colors duration-300">
        {running ? labelRunning : labelIdle}
      </span>
      <iconify-icon
        icon="solar:arrow-right-linear"
        width="20"
        height="20"
        className="relative z-10 group-hover:text-black transition-colors duration-300"
      />
    </button>
  );
}

export function RunScoringButton() {
  return (
    <ActionButton
      endpoint="/api/config/run-scoring"
      labelIdle="LANCER LE SCORING"
      labelRunning="EXÉCUTION..."
    />
  );
}

export function SyncServicesButton() {
  return (
    <ActionButton
      endpoint="/api/config/sync-services"
      labelIdle="SYNCHRONISER LES SERVICES"
      labelRunning="SYNCHRONISATION..."
      variant="danger"
    />
  );
}
