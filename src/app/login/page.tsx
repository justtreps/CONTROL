"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PixelEye } from "@/components/PixelEye";
import { useLoading } from "@/components/LoadingContext";

const CURTAIN_MS = 600;
const API_TRIGGER_MS = 500;
const LOADING_MIN_MS = 800;

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
        <div className="login-panel-left relative bg-[#030303] flex flex-col justify-between p-8 md:p-12 overflow-hidden min-h-[50vh] md:min-h-screen">
          <div className="relative z-10 flex flex-col gap-6">
            <div className="font-mono text-xs text-[#666666] tracking-widest border border-[#666666]/30 px-3 py-1 w-max">
              [ NODE: CONTROL | OPTICS: LOCKED ]
            </div>
            <PixelEye size={80} />
          </div>

          <div className="relative z-10 flex flex-col gap-4">
            <h1 className="brand font-display text-fluid-title uppercase tracking-tight leading-[0.85] m-0 text-white">
              CONTROL.
            </h1>
            <p className="font-mono text-xs text-[#666666] tracking-widest uppercase max-w-sm mt-4 leading-relaxed">
              AUTONOMOUS QUALITY ROUTING ENGINE. / ENGINEERED BY MY HUB SOLUTIONS.
            </p>
          </div>

          <div className="relative z-10 flex justify-between font-mono text-xs text-[#666666] tracking-widest">
            <span>[ SYS_VER: 1.0.0 ]</span>
            <span>[ AUTH: PENDING ]</span>
          </div>
        </div>

        {/* RIGHT — red panel */}
        <div className="login-panel-right relative bg-[#FF3300] text-black flex flex-col justify-center items-center p-8 md:p-12 min-h-[50vh] md:min-h-screen">
          <div className="w-full max-w-sm flex flex-col gap-8">
            <div className="font-mono text-xs tracking-widest border border-black/30 px-3 py-1 w-max">
              [ TERMINAL NODE | ACCESS RESTRICTED ]
            </div>

            <h2 className="brand font-display text-5xl md:text-6xl uppercase tracking-tight leading-none">
              Initiate.
            </h2>

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
                  className="interactive w-full bg-transparent border border-black/50 focus:border-black px-4 py-3 font-mono text-sm tracking-widest placeholder:text-black/40 outline-none transition-colors disabled:opacity-60"
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

            <div className="font-mono text-xs tracking-widest mt-8 pt-8 border-t border-black/30">
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
