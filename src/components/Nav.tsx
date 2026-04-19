"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/services", label: "Services" },
  { href: "/logs", label: "Logs" },
  { href: "/config", label: "Config" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        <Link href="/" className="brand text-2xl">
          myscore
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  active
                    ? "text-neutral-900 font-medium"
                    : "text-neutral-500 hover:text-neutral-900"
                }
              >
                {l.label}
              </Link>
            );
          })}
          <form action="/api/login" method="POST" className="inline">
            <input type="hidden" name="_method" value="DELETE" />
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/login", { method: "DELETE" });
                window.location.href = "/login";
              }}
              className="text-neutral-500 hover:text-neutral-900"
            >
              Logout
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
