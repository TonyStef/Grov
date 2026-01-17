'use client';

import { useState, useEffect } from 'react';
import InteractiveDemo from './InteractiveDemo';

const GitHubIcon = (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>
);

const NpmIcon = (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0v1.336H8.001V8.667h5.334v5.332h-2.669v-.001zm12.001 0h-1.33v-4h-1.336v4h-1.335v-4h-1.33v4h-2.671V8.667h8.002v5.331zM10.665 10H12v2.667h-1.335V10z"/>
  </svg>
);

const YouTubeIcon = (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

interface Stats {
  stars: string;
  downloads: string;
}

export default function Hero() {
  const [stats, setStats] = useState<Stats>({ stars: '-- stars', downloads: '-- downloads' });
  const [isVisible, setIsVisible] = useState(false);

  // Fade-in on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Fetch stats
  useEffect(() => {
    const controller = new AbortController();

    async function fetchStats() {
      try {
        const [ghRes, npmRes] = await Promise.all([
          fetch('https://api.github.com/repos/TonyStef/Grov', { signal: controller.signal }),
          fetch('https://api.npmjs.org/downloads/point/last-month/grov', { signal: controller.signal })
        ]);

        const results: Partial<Stats> = {};

        if (ghRes.ok) {
          const ghData = await ghRes.json();
          results.stars = `${ghData.stargazers_count} stars`;
        }

        if (npmRes.ok) {
          const npmData = await npmRes.json();
          const downloads = npmData.downloads;
          const formatted = downloads >= 1000
            ? `${(downloads / 1000).toFixed(1).replace(/\.0$/, '')}k`
            : downloads.toString();
          results.downloads = `${formatted} downloads`;
        }

        setStats(curr => ({ ...curr, ...results }));
      } catch (e) {
        if (e instanceof Error && e.name !== 'AbortError') {
          console.error('Failed to fetch stats:', e);
        }
      }
    }

    fetchStats();
    return () => controller.abort();
  }, []);

  return (
    <section className="min-h-screen flex items-center pt-24 pb-16 px-6">
      <div className="max-w-7xl mx-auto w-full">
        <div className="grid lg:grid-cols-[1fr_1.4fr] gap-12 lg:gap-16 items-start lg:pt-8">

          {/* Left: Content */}
          <div className="space-y-8 text-center lg:text-left">
            {/* Badge */}
            <div
              className={`inline-flex items-center gap-2 px-3 py-1.5 bg-grov-accent-bg border border-grov-accent/20 rounded-full transition-opacity duration-500 ${
                isVisible ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <span className="w-2 h-2 bg-grov-accent rounded-full animate-pulse" />
              <span className="font-mono text-xs text-grov-accent">For Teams Using AI Coding Assistants</span>
            </div>

            {/* Headline */}
            <h1
              className={`text-hero-mobile md:text-hero text-grov-text leading-tight transition-[opacity,transform] duration-500 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
              style={{ fontFamily: 'var(--font-display)', transitionDelay: '100ms' }}
            >
              Don't Let Reasoning<br />
              <span className="text-grov-accent">Die in the Tab.</span>
            </h1>

            {/* Subheadline */}
            <p
              className={`text-subhead text-grov-text-secondary max-w-lg mx-auto lg:mx-0 transition-[opacity,transform] duration-500 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
              style={{ transitionDelay: '200ms' }}
            >
              Grov automatically captures the context from your private AI sessions and syncs it to a shared team memory.
            </p>

            {/* CTAs */}
            <div
              className={`flex flex-col sm:flex-row gap-4 justify-center lg:justify-start transition-[opacity,transform] duration-500 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
              }`}
              style={{ transitionDelay: '400ms' }}
            >
              <a href="#install" className="btn-primary" style={{ touchAction: 'manipulation' }}>
                Initialize Memory
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

            {/* Trust signals */}
            <div
              className={`flex items-center gap-6 justify-center lg:justify-start pt-4 flex-wrap transition-opacity duration-500 ${
                isVisible ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ transitionDelay: '500ms' }}
            >
              <a
                href="https://github.com/TonyStef/Grov"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-grov-text-muted hover:text-grov-text transition-[color] min-h-[44px]"
                style={{ touchAction: 'manipulation' }}
              >
                {GitHubIcon}
                <span className="font-mono">{stats.stars}</span>
              </a>
              <a
                href="https://www.npmjs.com/package/grov"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-grov-text-muted hover:text-grov-text transition-[color] min-h-[44px]"
                style={{ touchAction: 'manipulation' }}
              >
                {NpmIcon}
                <span className="font-mono">{stats.downloads}</span>
              </a>
              <a
                href="https://www.producthunt.com/products/grov?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-grov"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center min-h-[44px]"
                style={{ touchAction: 'manipulation' }}
              >
                <img
                  src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1051166&theme=dark&t=1765984839313"
                  alt="Grov - Featured on Product Hunt"
                  width={180}
                  height={40}
                  className="opacity-80 hover:opacity-100 transition-opacity"
                  loading="lazy"
                />
              </a>
            </div>
          </div>

          {/* Right: Interactive Demo */}
          <div
            className={`relative transition-[opacity,transform] duration-500 ${
              isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'
            }`}
            style={{ transitionDelay: '300ms' }}
            id="demo"
          >
            <InteractiveDemo hideHeader />

            {/* Video CTA below demo */}
            <a
              href="https://www.youtube.com/watch?v=NvkG8Ddjgeg"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex items-center justify-center gap-3 px-4 py-3 rounded-lg border border-grov-border bg-grov-surface/50 hover:bg-grov-surface hover:border-grov-border-hover transition-[background-color,border-color] group min-h-[56px]"
              style={{ touchAction: 'manipulation' }}
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-full bg-red-600 group-hover:bg-red-500 transition-colors">
                {YouTubeIcon}
              </span>
              <div className="text-left">
                <div className="font-mono text-xs text-grov-text-muted">Watch the 4-minute demo</div>
                <div className="text-sm text-grov-text group-hover:text-grov-accent transition-colors">
                  Universal AI Context: From Terminal to IDE in seconds
                </div>
              </div>
            </a>

            {/* Subtle glow effect */}
            <div className="absolute -inset-8 bg-grov-accent/5 blur-3xl -z-10 rounded-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
