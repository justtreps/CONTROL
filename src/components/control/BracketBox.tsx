import type { ReactNode } from "react";

export function BracketBox({ children }: { children: ReactNode }) {
  return (
    <span className="brk">
      <span className="bracket">[</span>
      <span>{children}</span>
      <span className="bracket">]</span>
    </span>
  );
}
