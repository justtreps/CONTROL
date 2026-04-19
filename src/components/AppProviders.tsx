"use client";

import "iconify-icon";
import type { ReactNode } from "react";
import { ActivityProvider } from "./ActivityContext";
import { LoadingProvider } from "./LoadingContext";
import { LoadingScreen } from "./LoadingScreen";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LoadingProvider>
      <ActivityProvider>
        {children}
        <LoadingScreen />
      </ActivityProvider>
    </LoadingProvider>
  );
}
