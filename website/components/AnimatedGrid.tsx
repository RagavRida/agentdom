'use client';

import { useEffect, useRef } from 'react';

export default function AnimatedGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let targetX = 50;
    let targetY = 50;
    let currentX = 50;
    let currentY = 50;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      targetX = ((e.clientX - rect.left) / rect.width) * 100;
      targetY = ((e.clientY - rect.top) / rect.height) * 100;
    };

    const animate = () => {
      currentX += (targetX - currentX) * 0.05;
      currentY += (targetY - currentY) * 0.05;
      
      container.style.setProperty('--mouse-x', `${currentX}%`);
      container.style.setProperty('--mouse-y', `${currentY}%`);
      
      rafRef.current = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', handleMouseMove);
    rafRef.current = requestAnimationFrame(animate);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="animated-grid" aria-hidden="true">
      <div className="grid-lines" />
      <div className="grid-glow" />
    </div>
  );
}
