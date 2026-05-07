'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import AgentLogo from './AgentLogo';

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="nav-wrapper">
      <nav className={`nav ${scrolled ? 'nav-scrolled' : ''}`}>
        <Link href="/" className="nav-logo">
          <AgentLogo size={26} /> AgentDOM
        </Link>
        <div className="nav-links">
          <Link href="/#how">How It Works</Link>
          <Link href="/#features">Features</Link>
          <Link href="/docs">Docs</Link>
        </div>
        <a href="https://github.com/RagavRida/agentdom" className="nav-gh" target="_blank" rel="noopener">
          <ExternalLink size={14} /> GitHub
        </a>
      </nav>
    </div>
  );
}
