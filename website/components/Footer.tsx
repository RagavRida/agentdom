import Link from 'next/link';
import Image from 'next/image';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <Link href="/" className="footer-logo">
          <Image src="/logo.png" alt="" width={20} height={20} /> AgentDOM
        </Link>
        <div className="footer-links">
          <a href="https://github.com/RagavRida/agentdom" target="_blank" rel="noopener">GitHub</a>
          <a href="https://npmjs.com/package/agentdom" target="_blank" rel="noopener">npm</a>
          <Link href="/docs">Docs</Link>
        </div>
      </div>
      <div className="footer-copy">MIT License · Built for the agent era</div>
    </footer>
  );
}
