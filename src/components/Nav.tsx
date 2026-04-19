"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ControlEye } from "./ControlEye";

const LINKS = [
  { href: "/", label: "HOME" },
  { href: "/services", label: "SERVICES" },
  { href: "/logs", label: "LOGS" },
  { href: "/config", label: "CONFIG" },
];

export function Nav() {
  const pathname = usePathname();
  const [watching, setWatching] = useState(false);

  return (
    <header className="border-b border-grid bg-[var(--bg-color)]/80 backdrop-blur-sm relative z-20">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
        <div
          className="flex items-center gap-3"
          onMouseEnter={() => setWatching(true)}
          onMouseLeave={() => setWatching(false)}
        >
          <ControlEye watching={watching} />
          <Link
            href="/"
            className="brand text-xl tracking-[0.25em] interactive text-white"
          >
            CONTROL
          </Link>
        </div>

        <nav className="flex items-center gap-6 font-mono text-[11px] tracking-[0.2em]">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`interactive transition-colors ${
                  active
                    ? "text-accent"
                    : "text-text-muted hover:text-white"
                }`}
              >
                {active ? `[ ${l.label} ]` : l.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/login", { method: "DELETE" });
              window.location.href = "/login";
            }}
            className="interactive text-text-muted hover:text-white transition-colors"
          >
            LOGOUT
          </button>
        </nav>
      </div>
    </header>
  );
}
