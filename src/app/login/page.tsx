"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PixelEye } from "@/components/PixelEye";
import { useLoading } from "@/components/LoadingContext";

const SUBMIT_MIN_VISIBLE_MS = 1000;
const SUBMIT_HIDE_DELAY_MS = 600;

// (Login arrival animations removed — only the iron curtain plays.)

// Intro stages:
//   0 = pre-mount, curtain off-screen above (no paint)
//   1 = slamming down (380ms keyframe with overshoot + bounce)
//   2 = stase (held closed, CONTROL + KITT visible)
//   3 = opening (smooth 600ms slide back up)
//   4 = done (unmount, login form takes over)
const SLAM_MS = 380;
const STASE_MS = 500;
const OPEN_MS = 600;

function LoginIntro({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<0 | 1 | 2 | 3 | 4>(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      setStage(1);
      timers.push(setTimeout(() => !cancelled && setStage(2), SLAM_MS));
      timers.push(
        setTimeout(() => !cancelled && setStage(3), SLAM_MS + STASE_MS)
      );
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setStage(4);
          onDoneRef.current();
        }, SLAM_MS + STASE_MS + OPEN_MS)
      );
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      // Clear cursor-on-red so the login form behind doesn't keep the
      // black cursor after the curtain unmounts mid-hover.
      document.body.classList.remove("cursor-on-red");
    };
  }, []);

  if (stage === 4) return null;

  let curtainClass = "";
  if (stage === 0) {
    curtainClass = "-translate-y-full";
  } else if (stage === 1) {
    curtainClass = "curtain-slam";
  } else if (stage === 2) {
    curtainClass = "translate-y-0";
  } else if (stage === 3) {
    curtainClass = `-translate-y-full transition-transform duration-[${OPEN_MS}ms] ease-[cubic-bezier(0.77,0,0.175,1)]`;
  }

  return (
    <div
      className="fixed inset-0 z-[10000] overflow-hidden"
      data-cursor="invert"
      role="status"
      aria-live="polite"
      aria-hidden={stage === 0}
    >
      {/* Curtain — CONTROL content lives inside so it descends WITH the panel */}
      <div className={`absolute inset-0 iron-curtain-panel ${curtainClass}`}>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-black px-6">
          <div className="font-mono text-xs tracking-widest border border-black/30 px-4 py-1 mb-12">
            [ NŒUD TERMINAL | CHARGEMENT ]
          </div>
          <h1 className="brand font-display uppercase tracking-tight leading-[0.85] m-0 text-center text-fluid-title">
            CONTROL.
          </h1>
          <div className="flex flex-col items-center gap-3 mt-12">
            <div className="font-mono text-xs tracking-widest">
              PAR MY HUB SOLUTIONS
            </div>
            <div className="w-64 h-[1px] bg-black/30 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0 bg-black loading-bar" />
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">Chargement de CONTROL.</span>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? "/";
  const { show: showLoading, hide: hideLoading } = useLoading();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !password) return;
    setError(null);
    setSubmitting(true);
    showLoading();
    const start = Date.now();

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

    sessionStorage.setItem("control:curtain-shown", "1");
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, SUBMIT_MIN_VISIBLE_MS - elapsed);
    setTimeout(() => {
      router.push(from);
      router.refresh();
      setTimeout(() => hideLoading(), SUBMIT_HIDE_DELAY_MS);
    }, remaining);
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
            preload="metadata"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 w-full h-full object-cover opacity-55 mix-blend-screen z-0"
            src="/planet-earth.mov"
          />
          <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-b from-[#030303]/60 via-transparent to-[#030303]" />

          <div className="relative z-10 flex flex-col gap-6">
            <div className="font-mono text-xs text-[#666666] tracking-widest border border-[#666666]/30 px-3 py-1 w-max">
              [ NŒUD: CONTROL | OPTIQUE: VERROUILLÉ ]
            </div>
            <PixelEye size={80} />
          </div>

          <div className="relative z-10 flex flex-col">
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
  const [introDone, setIntroDone] = useState(false);
  const handleIntroDone = useCallback(() => setIntroDone(true), []);

  return (
    <>
      {/* Login form is always mounted behind, so when the curtain
          retracts the page is already there to be revealed. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      {!introDone && <LoginIntro onDone={handleIntroDone} />}
    </>
  );
}
