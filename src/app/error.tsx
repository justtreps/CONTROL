"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen w-full flex flex-col items-center justify-center px-6 relative">
      <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300]/40 px-3 py-1 mb-8">
        [ ERREUR SYSTÈME | CODE 500 ]
      </div>
      <h1
        className="brand font-display uppercase tracking-tight leading-[0.85] text-white text-center m-0"
        style={{ fontSize: "clamp(4rem, 14vw, 12rem)" }}
      >
        <span className="text-[#FF3300]">Anomalie.</span>
      </h1>
      {error.digest && (
        <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-6">
          REF : {error.digest}
        </p>
      )}
      <p className="font-mono text-xs text-[#666666] tracking-widest uppercase mt-8 text-center max-w-md leading-relaxed">
        UNE EXCEPTION A INTERROMPU LE PROCESSUS. LES CRONS ET LE ROUTING
        CONTINUENT EN ARRIÈRE-PLAN.
      </p>
      <div className="mt-12 flex gap-4">
        <button
          type="button"
          onClick={reset}
          className="interactive group relative border border-[#FF3300] bg-[#FF3300] py-3 px-6 overflow-hidden text-black"
        >
          <span className="relative font-mono text-xs tracking-widest font-bold z-10">
            RELANCER
          </span>
        </button>
      </div>
      <div className="absolute bottom-8 font-mono text-xs text-[#666666] tracking-widest">
        [ SYS_VER: 1.0.0 | PAR MY HUB SOLUTIONS ]
      </div>
    </main>
  );
}
