"use client";

import { useEffect, useRef } from "react";

type Particle = {
  baseX: number;
  baseY: number;
  opacity: number;
  phase: number;
};

export function BackgroundGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    const spacing = 40;
    const maxDist = 150;
    let frame: number;
    let mouseX = -1000;
    let mouseY = -1000;

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };

    const initGrid = () => {
      particles = [];
      for (let x = 0; x < width; x += spacing) {
        for (let y = 0; y < height; y += spacing) {
          particles.push({
            baseX: x,
            baseY: y,
            opacity: Math.random() * 0.3,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initGrid();
    };

    const draw = (time: number) => {
      ctx.fillStyle = "#030303";
      ctx.fillRect(0, 0, width, height);

      for (const p of particles) {
        const dx = mouseX - p.baseX;
        const dy = mouseY - p.baseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let offsetX = 0;
        let offsetY = 0;

        if (!reduced && dist < maxDist) {
          const force = (maxDist - dist) / maxDist;
          offsetX = (dx / dist) * force * -10;
          offsetY = (dy / dist) * force * -10;
          ctx.fillStyle = "#FF3300";
          if (Math.random() > 0.8) {
            ctx.fillRect(p.baseX + offsetX - 2, p.baseY + offsetY, 5, 1);
            ctx.fillRect(p.baseX + offsetX, p.baseY + offsetY - 2, 1, 5);
            continue;
          }
        } else {
          const flicker = reduced
            ? p.opacity
            : p.opacity + Math.sin(time * 0.002 + p.phase) * 0.1;
          const op = Math.max(0, flicker);
          ctx.fillStyle = `rgba(102, 102, 102, ${op})`;
        }

        ctx.fillRect(p.baseX + offsetX, p.baseY + offsetY, 1, 1);
      }

      frame = requestAnimationFrame(draw);
    };

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    resize();
    frame = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas id="gl-canvas" ref={canvasRef} aria-hidden="true" />;
}
