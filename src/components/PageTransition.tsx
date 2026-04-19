"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useLoading } from "./LoadingContext";

// Slam keyframe is 380ms + needs ~250ms stase to read CONTROL flash
// before opening kicks in.
const HOLD_MS = 650;

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
