"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "ok" | "err";
type Toast = { id: number; kind: ToastKind; msg: string };

type Ctx = { push: (kind: ToastKind, msg: string) => void };

const ToastCtx = createContext<Ctx>({ push: () => {} });

let nextId = 1;

export function PoolToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, kind, msg }]);
    // Errors stick around a bit longer so operators can read them
    // before they disappear. OK toasts stay at 3s (quick reinforcement).
    const ttl = kind === "err" ? 5000 : 3000;
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, ttl);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      {/* aria-live region — screen readers announce each new toast. */}
      <div
        className="fixed bottom-6 right-6 z-[9500] flex flex-col gap-2 pointer-events-none"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "err" ? "alert" : "status"}
            className={`pointer-events-auto font-mono text-xs tracking-widest uppercase px-4 py-2 border ${
              t.kind === "ok"
                ? "border-[#FF3300] text-white bg-[#030303]"
                : "border-white text-white bg-[#FF3300]"
            } animate-toast-in`}
          >
            <span
              className={`mr-2 ${
                t.kind === "ok" ? "text-[#FF3300]" : "text-black"
              }`}
              aria-hidden="true"
            >
              [{t.kind === "ok" ? "OK" : "ERR"}]
            </span>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function usePoolToast() {
  return useContext(ToastCtx);
}
