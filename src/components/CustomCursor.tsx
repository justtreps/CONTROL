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

    const tick = () => {
      dotX += (mouseX - dotX) * 0.25;
      dotY += (mouseY - dotY) * 0.25;
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${dotX}px, ${dotY}px, 0) translate(-50%, -50%)`;
      }
      bracketX += (mouseX - bracketX) * 0.12;
      bracketY += (mouseY - bracketY) * 0.12;
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
    };

    const onOut = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".interactive, a, button, [role='button']")) {
        document.body.classList.remove("hovering-interactive");
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
