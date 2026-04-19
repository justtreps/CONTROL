"use client";

import "iconify-icon";
import type { ReactNode } from "react";
import { ActivityProvider } from "./ActivityContext";
import { LoadingProvider } from "./LoadingContext";
import { LoadingScreen } from "./LoadingScreen";
import { PageTransition } from "./PageTransition";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LoadingProvider>
      <ActivityProvider>
        <PageTransition />
        {children}
        <LoadingScreen />
      </ActivityProvider>
    </LoadingProvider>
  );
}
