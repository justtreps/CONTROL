"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

type ActivityCtx = {
  flashTick: number;
  flash: () => void;
};

const ActivityContext = createContext<ActivityCtx>({
  flashTick: 0,
  flash: () => {},
});

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [flashTick, setFlashTick] = useState(0);
  const flash = useCallback(() => setFlashTick((t) => t + 1), []);
  return (
    <ActivityContext.Provider value={{ flashTick, flash }}>
      {children}
    </ActivityContext.Provider>
  );
}

export function useActivity() {
  return useContext(ActivityContext);
}
