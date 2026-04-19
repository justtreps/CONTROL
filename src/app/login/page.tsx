"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PixelEye } from "@/components/PixelEye";
import { useLoading } from "@/components/LoadingContext";

const CURTAIN_MS = 600;
const API_TRIGGER_MS = 500;
const LOADING_MIN_MS = 800;

const CONTROL_LETTERS = "CONTROL.".split("");
const INITIATE_LETTERS = "INITIATE.".split("");

// Arrival timing plan (total ~2.04s):
//   t=0      — eye boots (100ms)
//   t=100    — CONTROL letters (8 chars × 80ms stagger, 200ms each)
//   t=860    — left supporting content + right [ TERMINAL NODE ] fade (200ms)
//   t=1060   — INITIATE letters (9 chars × 60ms stagger, 200ms each)
//   t=1740   — form + right footer fade (300ms)
const DELAY_FADE_SUPPORT = 860;
const DELAY_INITIATE_START = 1060;
const DELAY_FORM_FADE = 1740;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? "/";
  const { show: showLoading } = useLoading();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !password) return;
    setError(null);
    setSubmitting(true);
    const start = Date.now();

    const fetchPromise = fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    await new Promise((r) => setTimeout(r, API_TRIGGER_MS));
    const res = await fetchPromise;

    if (res.ok) {
      sessionStorage.setItem("control:curtain-shown", "1");
      showLoading();
      const elapsed = Date.now() - start;
      const totalMin = CURTAIN_MS + LOADING_MIN_MS;
      const remaining = Math.max(0, totalMin - elapsed);
      setTimeout(() => {
        router.push(from);
        router.refresh();
      }, remaining);
      return;
    }

    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Mot de passe incorrect");
    setSubmitting(false);
  }

  return (
    <>
      <div className="min-h-screen w-full grid grid-cols-1 md:grid-cols-2 relative">
        {/* LEFT — black panel */}
        <div className="login-panel-left relative bg-[#030303] flex flex-col justify-between p-8 md:p-12 overflow-hidden min-h-[50vh] md:min-h-screen gap-12">
          <div className="relative z-10 flex flex-col gap-6">
            <div
              className="arrival-fade font-mono text-xs text-[#666666] tracking-widest border border-[#666666]/30 px-3 py-1 w-max"
              style={{ animationDelay: `${DELAY_FADE_SUPPORT}ms` }}
            >
              [ NODE: CONTROL | OPTICS: LOCKED ]
            </div>
            <div className="arrival-eye" style={{ animationDelay: "0ms" }}>
              <PixelEye size={80} />
            </div>
          </div>

          <div className="relative z-10 flex flex-col">
            <h1
              className="brand font-display uppercase tracking-tight leading-[0.85] m-0 text-white"
              style={{ fontSize: "clamp(4rem, 10vw, 9rem)" }}
              aria-label="CONTROL."
            >
              {CONTROL_LETTERS.map((c, i) => (
                <span
                  key={i}
                  className="arrival-letter"
                  style={{ animationDelay: `${100 + i * 80}ms` }}
                  aria-hidden="true"
                >
                  {c}
                </span>
              ))}
            </h1>
            <p
              className="arrival-fade font-mono text-xs text-[#666666] tracking-widest uppercase max-w-sm mt-8 leading-relaxed"
              style={{ animationDelay: `${DELAY_FADE_SUPPORT}ms` }}
            >
              AUTONOMOUS QUALITY ROUTING ENGINE. / ENGINEERED BY MY HUB SOLUTIONS.
            </p>
          </div>

          <div
            className="arrival-fade relative z-10 flex justify-between font-mono text-sm text-[#666666] tracking-widest"
            style={{ animationDelay: `${DELAY_FADE_SUPPORT + 40}ms` }}
          >
            <span>[ SYS_VER: 1.0.0 ]</span>
            <span>[ AUTH: PENDING ]</span>
          </div>
        </div>

        {/* RIGHT — red panel */}
        <div
          data-cursor="invert"
          className="login-panel-right relative bg-[#FF3300] text-black flex flex-col justify-between items-center p-8 md:p-12 min-h-[50vh] md:min-h-screen gap-12"
        >
          {/* Top */}
          <div className="w-full max-w-sm">
            <div
              className="arrival-fade font-mono text-xs tracking-widest border border-black/30 px-3 py-1 w-max"
              style={{ animationDelay: `${DELAY_FADE_SUPPORT}ms` }}
            >
              [ TERMINAL NODE | ACCESS RESTRICTED ]
            </div>
          </div>

          {/* Middle */}
          <div className="w-full max-w-sm flex flex-col gap-6">
            <h2
              className="brand font-display text-5xl md:text-6xl uppercase tracking-tight leading-none"
              aria-label="Initiate."
            >
              {INITIATE_LETTERS.map((c, i) => (
                <span
                  key={i}
                  className="arrival-letter"
                  style={{ animationDelay: `${DELAY_INITIATE_START + i * 60}ms` }}
                  aria-hidden="true"
                >
                  {c}
                </span>
              ))}
            </h2>

            <div
              className="arrival-form-fade flex flex-col gap-6"
              style={{ animationDelay: `${DELAY_FORM_FADE}ms` }}
            >
              <p className="font-mono text-xs tracking-widest uppercase leading-relaxed">
                SUBMIT CREDENTIALS TO ESTABLISH SESSION.
              </p>

              <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="pwd"
                    className="font-mono text-xs tracking-widest uppercase"
                  >
                    [ PASSWORD ]
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
                    [ INITIATE ]
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
                    [ ERROR ] {error}
                  </p>
                )}
              </form>
            </div>
          </div>

          {/* Bottom */}
          <div
            className="arrival-form-fade w-full max-w-sm"
            style={{ animationDelay: `${DELAY_FORM_FADE}ms` }}
          >
            <div className="font-mono text-xs tracking-widest pt-8 border-t border-black/30">
              BY MY HUB SOLUTIONS / © 2026
            </div>
          </div>
        </div>
      </div>

      {/* Curtain overlay */}
      <div
        className={`login-curtain fixed inset-0 z-[9999] pointer-events-none ${
          submitting ? "active" : ""
        }`}
        aria-hidden="true"
      >
        <div className="curtain-left absolute inset-y-0 left-0 w-1/2 bg-[#030303]" />
        <div className="curtain-right absolute inset-y-0 right-0 w-1/2 bg-[#FF3300]" />
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
