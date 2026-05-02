'use client';

import { useRef, useState, ReactNode } from 'react';
import Link from 'next/link';

interface MagneticButtonProps {
  children: ReactNode;
  href?: string;
  className?: string;
  external?: boolean;
  onClick?: () => void;
}

export default function MagneticButton({ 
  children, 
  href, 
  className = '',
  external = false,
  onClick 
}: MagneticButtonProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const x = (e.clientX - centerX) * 0.3;
    const y = (e.clientY - centerY) * 0.3;
    setPosition({ x, y });
  };

  const handleMouseLeave = () => {
    setPosition({ x: 0, y: 0 });
  };

  const style = {
    transform: `translate(${position.x}px, ${position.y}px)`,
    transition: position.x === 0 ? 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
  };

  const content = (
    <div
      ref={ref}
      className={className}
      style={style}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {children}
    </div>
  );

  if (href && external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
    );
  }

  if (href) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}
