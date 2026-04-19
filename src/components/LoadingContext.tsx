"use client";

import {
  createContext,
  useCallback,
  useContext,
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

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => setVisible(false), []);

  return <Ctx.Provider value={{ visible, show, hide }}>{children}</Ctx.Provider>;
}

export function useLoading() {
  return useContext(Ctx);
}
