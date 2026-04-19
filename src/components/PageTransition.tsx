"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useLoading } from "./LoadingContext";

// slam (380ms) + stase (500ms) — then smooth retract kicks in
const HOLD_MS = 880;

export function PageTransition() {
  const pathname = usePathname();
  const { show, hide } = useLoading();
  const isFirstRef = useRef(true);

  useEffect(() => {
    if (isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    show();
    const t = setTimeout(hide, HOLD_MS);
    return () => clearTimeout(t);
  }, [pathname, show, hide]);

  return null;
}
