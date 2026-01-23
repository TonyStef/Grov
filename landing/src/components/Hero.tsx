'use client';

import { useState, useEffect, useRef } from 'react';

// Hoisted static SVG icons
const CopyIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export default function Hero() {
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText('npm install -g grov');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = 'npm install -g grov';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Measure the container for SVG dimensions
  useEffect(() => {
    const updateSize = () => {
      if (wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        setSvgSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  return (
    <section className="min-h-screen flex items-center pt-28 pb-20 px-6">
      <div className="max-w-6xl mx-auto w-full">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">

          {/* Left: Content */}
          <div className="space-y-8 text-center lg:text-left">
            {/* Badge - minimal annotation style */}
            <div
              className={`inline-flex items-center transition-opacity duration-500 ${
                isVisible ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <span className="text-grov-text-muted text-sm tracking-wide">
                <span className="text-grov-accent font-medium">//</span>
                {' '}for teams using AI coding assistants
              </span>
            </div>

            {/* Headline */}
            <h1
              className={`text-hero-mobile md:text-hero text-grov-text text-balance transition-all duration-700 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
              }`}
              style={{ fontFamily: 'var(--font-display)', transitionDelay: '100ms' }}
            >
              Don't Let Reasoning<br />
              <span className="text-grov-accent">Die in the Tab.</span>
            </h1>

            {/* Subheadline */}
            <p
              className={`text-subhead text-grov-text-secondary max-w-lg mx-auto lg:mx-0 text-pretty transition-all duration-700 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
              }`}
              style={{ transitionDelay: '200ms' }}
            >
              Grov automatically captures the context from your private AI sessions and syncs it to a shared team memory.
            </p>

            {/* CTAs */}
            <div
              className={`flex flex-col sm:flex-row gap-4 justify-center lg:justify-start transition-all duration-700 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
              }`}
              style={{ transitionDelay: '300ms' }}
            >
              <a
                href="https://github.com/TonyStef/Grov"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
                style={{ touchAction: 'manipulation' }}
              >
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                View on GitHub
              </a>
              <button
                data-cal-link="stef-antonio-virgil-hdzzp1"
                data-cal-config='{"theme":"dark"}'
                className="btn-secondary"
                style={{ touchAction: 'manipulation' }}
              >
                Schedule a Demo
              </button>
            </div>
          </div>

          {/* Right: Install Terminal */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
            style={{ transitionDelay: '300ms' }}
          >
            <div className="relative" ref={wrapperRef}>
              {/* Animated border SVG */}
              {svgSize.width > 0 && (
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  style={{ overflow: 'visible' }}
                  aria-hidden="true"
                >
                  <rect
                    x="0"
                    y="0"
                    width={svgSize.width}
                    height={svgSize.height}
                    rx="24"
                    ry="24"
                    fill="none"
                    stroke="url(#border-gradient)"
                    strokeWidth="1.5"
                    className="animate-dash"
                    pathLength="100"
                  />
                  <defs>
                    <linearGradient id="border-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0" />
                      <stop offset="40%" stopColor="#34d399" stopOpacity="1" />
                      <stop offset="60%" stopColor="#34d399" stopOpacity="1" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
              )}

              {/* Terminal */}
              <div className="relative rounded-2xl border border-grov-border bg-grov-surface overflow-hidden">
                {/* Terminal header */}
                <div className="px-4 py-3 border-b border-grov-border flex items-center gap-2">
                  <div className="flex gap-2" aria-hidden="true">
                    <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                    <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
                    <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
                  </div>
                  <span className="ml-2 text-xs text-grov-text-muted font-mono">terminal</span>
                </div>

                {/* Terminal content */}
                <div className="p-6 md:p-8">
                  {/* Install command */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 font-mono">
                      <span className="text-grov-accent text-lg">$</span>
                      <code className="text-grov-text text-lg md:text-xl">npm install -g grov</code>
                    </div>
                    <button
                      onClick={handleCopy}
                      className={`p-2.5 rounded-xl transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grov-accent ${
                        copied
                          ? 'bg-grov-accent/20 text-grov-accent'
                          : 'text-grov-text-muted hover:text-grov-text hover:bg-grov-surface-elevated'
                      }`}
                      style={{ touchAction: 'manipulation' }}
                      aria-label={copied ? 'Copied!' : 'Copy to clipboard'}
                    >
                      {copied ? CheckIcon : CopyIcon}
                    </button>
                  </div>

                  {/* Tagline */}
                  <div className="mt-6 pt-6 border-t border-grov-border">
                    <div className="flex items-center gap-3 text-grov-accent">
                      <span>✓</span>
                      <span className="text-grov-text-secondary">It's the only memory layer you need.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
