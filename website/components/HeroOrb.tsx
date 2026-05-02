'use client';

import { useEffect, useRef } from 'react';

export default function HeroOrb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const targetMouseRef = useRef({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let time = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      targetMouseRef.current = {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    };

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      // Smooth mouse interpolation
      mouseRef.current.x = lerp(mouseRef.current.x, targetMouseRef.current.x, 0.03);
      mouseRef.current.y = lerp(mouseRef.current.y, targetMouseRef.current.y, 0.03);

      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = Math.min(width, height) * 0.28;

      // Mouse influence on orb position
      const mouseOffsetX = (mouseRef.current.x - 0.5) * 60;
      const mouseOffsetY = (mouseRef.current.y - 0.5) * 60;

      // Draw multiple layered orbs with different phases
      for (let layer = 0; layer < 5; layer++) {
        const layerOffset = layer * 0.4;
        const layerScale = 1 - layer * 0.12;
        const radius = baseRadius * layerScale;

        // Create morphing blob shape
        ctx.beginPath();
        const points = 180;
        for (let i = 0; i <= points; i++) {
          const angle = (i / points) * Math.PI * 2;
          
          // Multiple noise frequencies for organic movement
          const noise1 = Math.sin(angle * 3 + time * 0.8 + layerOffset) * 0.12;
          const noise2 = Math.sin(angle * 5 - time * 0.6 + layerOffset * 2) * 0.08;
          const noise3 = Math.sin(angle * 7 + time * 1.2 + layerOffset * 3) * 0.05;
          const noise4 = Math.cos(angle * 2 - time * 0.4) * 0.06;
          
          const totalNoise = 1 + noise1 + noise2 + noise3 + noise4;
          const r = radius * totalNoise;

          const x = centerX + mouseOffsetX * (1 - layer * 0.15) + Math.cos(angle) * r;
          const y = centerY + mouseOffsetY * (1 - layer * 0.15) + Math.sin(angle) * r;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();

        // Gradient with orange accent colors
        const gradient = ctx.createRadialGradient(
          centerX + mouseOffsetX,
          centerY + mouseOffsetY,
          0,
          centerX + mouseOffsetX,
          centerY + mouseOffsetY,
          radius * 1.5
        );

        if (layer === 0) {
          // Core - bright orange
          gradient.addColorStop(0, 'rgba(249, 115, 22, 0.25)');
          gradient.addColorStop(0.5, 'rgba(234, 88, 12, 0.12)');
          gradient.addColorStop(1, 'rgba(249, 115, 22, 0)');
        } else if (layer === 1) {
          // Second layer - warm orange glow
          gradient.addColorStop(0, 'rgba(251, 146, 60, 0.15)');
          gradient.addColorStop(0.6, 'rgba(249, 115, 22, 0.06)');
          gradient.addColorStop(1, 'rgba(234, 88, 12, 0)');
        } else if (layer === 2) {
          // Third layer - soft amber
          gradient.addColorStop(0, 'rgba(245, 158, 11, 0.08)');
          gradient.addColorStop(0.7, 'rgba(249, 115, 22, 0.03)');
          gradient.addColorStop(1, 'rgba(251, 146, 60, 0)');
        } else {
          // Outer layers - very subtle
          gradient.addColorStop(0, `rgba(249, 115, 22, ${0.04 - layer * 0.01})`);
          gradient.addColorStop(1, 'rgba(249, 115, 22, 0)');
        }

        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Add floating particles around the orb
      const particleCount = 30;
      for (let i = 0; i < particleCount; i++) {
        const particleTime = time * 0.3 + i * 0.5;
        const orbitRadius = baseRadius * (1.2 + Math.sin(i * 0.7) * 0.5);
        const angle = (i / particleCount) * Math.PI * 2 + particleTime * 0.2;
        
        const px = centerX + mouseOffsetX * 0.5 + Math.cos(angle) * orbitRadius;
        const py = centerY + mouseOffsetY * 0.5 + Math.sin(angle) * orbitRadius * 0.8;
        
        const particleSize = 1 + Math.sin(particleTime + i) * 0.5;
        const opacity = 0.15 + Math.sin(particleTime * 2 + i * 0.3) * 0.1;

        ctx.beginPath();
        ctx.arc(px, py, particleSize, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(249, 115, 22, ${opacity})`;
        ctx.fill();
      }

      // Inner bright core
      const coreGradient = ctx.createRadialGradient(
        centerX + mouseOffsetX,
        centerY + mouseOffsetY,
        0,
        centerX + mouseOffsetX,
        centerY + mouseOffsetY,
        baseRadius * 0.4
      );
      coreGradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
      coreGradient.addColorStop(0.5, 'rgba(255, 237, 213, 0.04)');
      coreGradient.addColorStop(1, 'rgba(249, 115, 22, 0)');

      ctx.beginPath();
      ctx.arc(
        centerX + mouseOffsetX,
        centerY + mouseOffsetY,
        baseRadius * 0.4,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = coreGradient;
      ctx.fill();

      time += 0.015;
      animationId = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouseMove);
    draw();

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="hero-orb"
      aria-hidden="true"
    />
  );
}
