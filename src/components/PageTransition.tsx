"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useLoading } from "./LoadingContext";

const SHOW_HOLD_MS = 350;

export function PageTransition() {
  const pathname = usePathname();
  const { show, hide } = useLoading();
  const isFirstRef = useRef(true);

  useEffect(() => {
    if (isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    if (pathname === "/login") return;
    show();
    const t = setTimeout(() => hide(), SHOW_HOLD_MS);
    return () => clearTimeout(t);
  }, [pathname, show, hide]);

  return null;
}
