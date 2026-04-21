"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ControlLogo } from "./control";

const LINKS = [
  { href: "/", label: "ACCUEIL" },
  { href: "/services", label: "SERVICES" },
  { href: "/logs", label: "JOURNAUX" },
  { href: "/pool", label: "COMPTES TEST" },
  { href: "/config", label: "CONFIG" },
  { href: "/library", label: "LIBRARY" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function logout() {
    await fetch("/api/login", { method: "DELETE" });
    window.location.href = "/login";
  }

  return (
    <header className="border-b border-grid bg-[var(--bg-color)]/80 backdrop-blur-sm relative z-20">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-4 md:px-6 py-4 gap-4">
        <Link href="/" className="interactive flex-shrink-0">
          <ControlLogo size="sm" />
        </Link>

        {/* Desktop / tablet nav — hidden on small screens */}
        <nav className="hidden lg:flex items-center gap-6 font-mono text-[11px] tracking-[0.2em]">
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
            onClick={logout}
            className="interactive text-text-muted hover:text-white transition-colors"
          >
            DÉCONNEXION
          </button>
        </nav>

        {/* Mobile burger — visible below lg */}
        <button
          type="button"
          aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="interactive lg:hidden flex flex-col gap-[5px] p-2 -mr-2"
        >
          <span
            className={`block w-6 h-[2px] bg-white transition-transform ${
              open ? "rotate-45 translate-y-[7px]" : ""
            }`}
          />
          <span
            className={`block w-6 h-[2px] bg-white transition-opacity ${
              open ? "opacity-0" : ""
            }`}
          />
          <span
            className={`block w-6 h-[2px] bg-white transition-transform ${
              open ? "-rotate-45 -translate-y-[7px]" : ""
            }`}
          />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden border-t border-[#666666]/20 bg-[var(--bg-color)]">
          <nav className="flex flex-col max-w-7xl mx-auto px-4 py-2 font-mono text-xs tracking-[0.2em]">
            {LINKS.map((l) => {
              const active =
                l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`interactive py-3 border-b border-[#666666]/10 transition-colors ${
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
              onClick={logout}
              className="interactive py-3 text-left text-text-muted hover:text-white transition-colors"
            >
              DÉCONNEXION
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}
