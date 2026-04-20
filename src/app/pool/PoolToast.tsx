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
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[9500] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
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
