import type { ReactNode } from "react";

export function KBDKey({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
