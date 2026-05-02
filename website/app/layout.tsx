import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgentDOM — The Universal Runtime for AI Agents',
  description: 'Give AI agents structured, typed access to any software — web, desktop, CLI. No screenshots. Works with OpenAI, Gemini, Claude/MCP. Open source.',
  icons: { icon: '/logo.png', apple: '/logo.png' },
  openGraph: {
    title: 'AgentDOM — The Universal Runtime for AI Agents',
    description: 'The protocol that turns any software interface into callable functions for AI agents. No screenshots needed.',
    url: 'https://getagentdom.com',
    siteName: 'AgentDOM',
    type: 'website',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'AgentDOM — One protocol. Every machine.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentDOM — The Universal Runtime for AI Agents',
    description: 'Give AI agents structured, typed access to any software. No screenshots. Open source.',
    images: ['/og-image.png'],
  },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'AgentDOM',
  description: 'The universal runtime that gives AI agents structured access to any software interface — web, desktop, CLI.',
  url: 'https://getagentdom.com',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Windows, Linux',
  license: 'https://opensource.org/licenses/MIT',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  author: { '@type': 'Organization', name: 'AgentDOM', url: 'https://getagentdom.com' },
};

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is AgentDOM?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'AgentDOM is an open-source protocol that gives AI agents structured, typed access to any software interface — web, desktop, and CLI. Instead of screenshot-based interaction, it creates a machine-readable schema that agents use to call named functions.',
      },
    },
    {
      '@type': 'Question',
      name: 'How is AgentDOM different from screenshot-based agents?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Screenshot agents take a picture of the screen and use vision models to guess where to click. AgentDOM creates a structured schema — forms become typed functions like login(email, password). This is faster (milliseconds vs seconds), cheaper (no vision API costs), and deterministic.',
      },
    },
    {
      '@type': 'Question',
      name: 'What platforms does AgentDOM support?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'AgentDOM supports web (via script tag or npm), desktop (macOS and Windows via native APIs), and CLI. It integrates with OpenAI, Google Gemini, Claude/MCP, HTTP API, A2A Protocol, and has a Chrome Extension.',
      },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      </head>
      <body style={{ fontFamily: 'var(--font-sans)' }}>
        {children}
      </body>
    </html>
  );
}
