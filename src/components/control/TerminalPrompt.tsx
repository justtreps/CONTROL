import type { ReactNode } from "react";

export function TerminalPrompt({
  children,
  prompt = "$",
  cursor = true,
}: {
  children: ReactNode;
  prompt?: string;
  cursor?: boolean;
}) {
  return (
    <div className="term">
      <span className="prompt-sym">{prompt}</span>
      <span>{children}</span>
      {cursor && <span className="cursor">█</span>}
    </div>
  );
}
