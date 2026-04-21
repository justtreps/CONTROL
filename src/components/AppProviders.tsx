"use client";

import "iconify-icon";
import type { ReactNode } from "react";
import { ActivityProvider } from "./ActivityContext";
import { LoadingProvider } from "./LoadingContext";
import { LoadingScreen } from "./LoadingScreen";

// NOTE: the old <PageTransition /> that fired the iron-curtain on
// every pathname change has been removed. It made every navigation
// look like a heavy async load (~880ms lock-up for nothing) and made
// the app feel slow. The LoadingScreen + LoadingProvider stay so
// real async actions (scrape / health-check / recheck / integrate /
// config save / danger-zone destructive calls) can still surface
// the curtain explicitly via useLoading().show()/hide().
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
