"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useLoading } from "./LoadingContext";

// Iron curtain takes 600ms to descend + needs >=200ms stase before
// the open looks intentional. 900ms hold means the global show/hide
// pair triggers: descend (0-600) + stase (600-900) + open (900-1500).
const HOLD_MS = 900;

export function PageTransition() {
  const pathname = usePathname();
  const { show, hide } = useLoading();
  const isFirstRef = useRef(true);

  useEffect(() => {
    if (isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    // /login has its own LoginIntro curtain; don't double up.
    if (pathname === "/login") return;
    show();
    const t = setTimeout(hide, HOLD_MS);
    return () => clearTimeout(t);
  }, [pathname, show, hide]);

  return null;
}
