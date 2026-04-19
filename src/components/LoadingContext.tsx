"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

type LoadingCtx = {
  visible: boolean;
  show: () => void;
  hide: () => void;
};

const Ctx = createContext<LoadingCtx>({
  visible: false,
  show: () => {},
  hide: () => {},
});

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  const show = useCallback(() => {
    shownAtRef.current = Date.now();
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    const elapsed = shownAtRef.current ? Date.now() - shownAtRef.current : 0;
    const remaining = Math.max(0, 800 - elapsed);
    setTimeout(() => setVisible(false), remaining);
  }, []);

  return <Ctx.Provider value={{ visible, show, hide }}>{children}</Ctx.Provider>;
}

export function useLoading() {
  return useContext(Ctx);
}
