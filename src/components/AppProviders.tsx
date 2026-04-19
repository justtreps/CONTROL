"use client";

import type { ReactNode } from "react";
import { ActivityProvider } from "./ActivityContext";

export function AppProviders({ children }: { children: ReactNode }) {
  return <ActivityProvider>{children}</ActivityProvider>;
}
