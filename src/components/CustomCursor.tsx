"use client";

import { useEffect, useRef } from "react";

export function CustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const bracketsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(pointer: coarse)").matches) return;

    let mouseX = -1000;
    let mouseY = -1000;
    let dotX = -1000;
    let dotY = -1000;
    let bracketX = -1000;
    let bracketY = -1000;
    let frame: number;

    document.body.classList.add("has-custom-cursor");

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };

    let precise = false;
    const tick = () => {
      dotX += (mouseX - dotX) * 0.25;
      dotY += (mouseY - dotY) * 0.25;
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${dotX}px, ${dotY}px, 0) translate(-50%, -50%)`;
      }
      // In precise mode (e.g. over a chart) brackets snap to the real
      // mouse position so visual and data-under-cursor stay aligned.
      const lerp = precise ? 1 : 0.12;
      bracketX += (mouseX - bracketX) * lerp;
      bracketY += (mouseY - bracketY) * lerp;
      if (bracketsRef.current) {
        bracketsRef.current.style.transform = `translate3d(${bracketX}px, ${bracketY}px, 0) translate(-50%, -50%)`;
      }
      frame = requestAnimationFrame(tick);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".interactive, a, button, [role='button']")) {
        document.body.classList.add("hovering-interactive");
      }
      if (t?.closest("[data-cursor='invert']")) {
        document.body.classList.add("cursor-on-red");
      }
      if (t?.closest("[data-cursor='precise']")) {
        precise = true;
      }
    };

    const onOut = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const r = e.relatedTarget as HTMLElement | null;
      const interactiveSel = ".interactive, a, button, [role='button']";

      if (t?.closest(interactiveSel)) {
        const goingToInteractive = r?.closest?.(interactiveSel);
        if (!goingToInteractive) {
          document.body.classList.remove("hovering-interactive");
        }
      }
      if (t?.closest("[data-cursor='invert']")) {
        const goingToInvert = r?.closest?.("[data-cursor='invert']");
        if (!goingToInvert) {
          document.body.classList.remove("cursor-on-red");
        }
      }
      if (t?.closest("[data-cursor='precise']")) {
        const goingToPrecise = r?.closest?.("[data-cursor='precise']");
        if (!goingToPrecise) {
          precise = false;
        }
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    tick();

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.body.classList.remove("has-custom-cursor");
      document.body.classList.remove("hovering-interactive");
      document.body.classList.remove("cursor-on-red");
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div id="cursor-dot" ref={dotRef} aria-hidden="true" />
      <div id="cursor-brackets" ref={bracketsRef} aria-hidden="true" />
    </>
  );
}
