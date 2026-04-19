"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ControlLogo } from "./control";

const LINKS = [
  { href: "/", label: "ACCUEIL" },
  { href: "/services", label: "SERVICES" },
  { href: "/logs", label: "JOURNAUX" },
  { href: "/config", label: "CONFIG" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-grid bg-[var(--bg-color)]/80 backdrop-blur-sm relative z-20">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
        <Link href="/" className="interactive">
          <ControlLogo size="sm" />
        </Link>

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
            DÉCONNEXION
          </button>
        </nav>
      </div>
    </header>
  );
}
