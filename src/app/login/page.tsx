"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ControlEye } from "@/components/control";
import { useLoading } from "@/components/LoadingContext";

const ARRIVAL_HOLD_MS = 880;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? "/";
  const { show: showLoading, hide: hideLoading } = useLoading();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    showLoading();
    const t = setTimeout(hideLoading, ARRIVAL_HOLD_MS);
    return () => clearTimeout(t);
  }, [showLoading, hideLoading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !password) return;
    setError(null);
    setSubmitting(true);
    showLoading();

    let res: Response;
    try {
      res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch {
      hideLoading();
      setError("Erreur réseau");
      setSubmitting(false);
      return;
    }

    if (!res.ok) {
      hideLoading();
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Mot de passe incorrect");
      setSubmitting(false);
      return;
    }

    // Soft nav so the curtain stays mounted and PageTransition finishes
    // the slam → stase → retract cycle on the destination page.
    router.push(from);
    router.refresh();
  }

  return (
    <>
      <div className="min-h-screen w-full grid grid-cols-1 md:grid-cols-2 relative">
        <div className="login-panel-left relative bg-[#030303] flex flex-col justify-between p-8 md:p-12 overflow-hidden min-h-[50vh] md:min-h-screen gap-12">
          <video
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 w-full h-full object-cover opacity-55 mix-blend-screen z-0"
            src="/planet-earth.mp4"
          />
          <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-b from-[#030303]/60 via-transparent to-[#030303]" />

          <div className="relative z-10 flex flex-col gap-6">
            <div className="font-mono text-xs text-[#666666] tracking-widest border border-[#666666]/30 px-3 py-1 w-max">
              [ NŒUD: CONTROL | OPTIQUE: VERROUILLÉ ]
            </div>
          </div>

          <div className="relative z-10 flex flex-col items-start gap-6">
            <ControlEye size={140} />
            <h1
              className="brand font-display uppercase tracking-tight leading-[0.85] m-0 text-white"
              style={{ fontSize: "clamp(4rem, 10vw, 9rem)" }}
            >
              CONTROL.
            </h1>
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase max-w-sm mt-8 leading-relaxed">
              MOTEUR DE ROUTAGE QUALITÉ AUTONOME. / CONÇU PAR MY HUB SOLUTIONS.
            </p>
          </div>

          <div className="relative z-10 flex justify-between font-mono text-sm text-[#666666] tracking-widest">
            <span>[ SYS_VER: 1.0.0 ]</span>
            <span>[ AUTH: EN ATTENTE ]</span>
          </div>
        </div>

        <div
          data-cursor="invert"
          className="login-panel-right relative bg-[#FF3300] text-black flex flex-col justify-between items-center p-8 md:p-12 min-h-[50vh] md:min-h-screen gap-12"
        >
          <div className="w-full max-w-sm">
            <div className="font-mono text-xs tracking-widest border border-black/30 px-3 py-1 w-max">
              [ NŒUD TERMINAL | ACCÈS RESTREINT ]
            </div>
          </div>

          <div className="w-full max-w-sm flex flex-col gap-6">
            <h2 className="brand font-display text-5xl md:text-6xl uppercase tracking-tight leading-none">
              ACCÉDER.
            </h2>

            <div className="flex flex-col gap-6">
              <p className="font-mono text-xs tracking-widest uppercase leading-relaxed">
                SOUMETTEZ VOS IDENTIFIANTS POUR OUVRIR LA SESSION.
              </p>

              <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="pwd"
                    className="font-mono text-xs tracking-widest uppercase"
                  >
                    [ MOT DE PASSE ]
                  </label>
                  <input
                    id="pwd"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="current-password"
                    disabled={submitting}
                    className="interactive w-full bg-transparent border-2 border-black focus:border-black px-4 py-3 font-mono text-sm tracking-widest placeholder:text-black/50 caret-black outline-none transition-colors disabled:opacity-60"
                    placeholder="•••••••••"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting || !password}
                  className="interactive group relative w-full border border-black bg-black text-[#FF3300] py-4 px-6 overflow-hidden flex justify-between items-center text-left mt-2 disabled:opacity-60"
                >
                  <div className="absolute inset-0 bg-[#FF3300] transform translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out z-0" />
                  <span className="font-mono text-xs tracking-widest z-10 group-hover:text-black transition-colors duration-300">
                    [ ACCÉDER ]
                  </span>
                  <iconify-icon
                    icon="solar:arrow-right-linear"
                    width="20"
                    height="20"
                    className="relative z-10 group-hover:text-black transition-colors duration-300"
                  />
                </button>

                {error && (
                  <p
                    role="alert"
                    aria-live="polite"
                    className="font-mono text-xs tracking-widest uppercase mt-2"
                  >
                    [ ERREUR ] {error}
                  </p>
                )}
              </form>
            </div>
          </div>

          <div className="w-full max-w-sm">
            <div className="font-mono text-xs tracking-widest pt-8 border-t border-black/30">
              PAR MY HUB SOLUTIONS / © 2026
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
