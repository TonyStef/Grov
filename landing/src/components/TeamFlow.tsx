'use client';

import { useState, useEffect, useRef } from 'react';

// Person silhouette SVG - minimal, geometric
const PersonSilhouette = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 80 100" fill="currentColor" className={className} aria-hidden="true">
    <circle cx="40" cy="24" r="20" />
    <path d="M40 50 C10 50 4 75 4 100 L76 100 C76 75 70 50 40 50Z" />
  </svg>
);

// Memory/cloud icon
const MemoryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-grov-accent">
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
  </svg>
);

export default function TeamFlow() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className={`py-28 px-6 transition-opacity duration-700 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-20">
          <h2
            className="text-section-mobile md:text-section text-grov-text text-balance"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Shared team memory
          </h2>
          <p className="mt-6 text-body-lg text-grov-text-secondary max-w-xl mx-auto">
            What one person learns, everyone knows.
          </p>
        </div>

        {/* Visual - Horizontal layout */}
        <div className="flex items-center justify-center gap-6 md:gap-10">
          {/* Person 1 */}
          <div
            className={`flex flex-col items-center transition-opacity duration-500 ${
              isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDelay: '100ms' }}
          >
            <div className="w-14 h-[70px] md:w-16 md:h-20 text-grov-text-muted">
              <PersonSilhouette />
            </div>
            <span className="mt-2 text-xs text-grov-text-muted font-mono">dev-1</span>
          </div>

          {/* Line 1 */}
          <div
            className={`flex-1 max-w-16 md:max-w-24 h-px bg-grov-border transition-opacity duration-500 ${
              isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDelay: '200ms' }}
          />

          {/* Center: Memory cloud */}
          <div
            className={`flex flex-col items-center transition-opacity duration-500 ${
              isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDelay: '300ms' }}
          >
            <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-grov-surface border border-grov-accent/30 flex items-center justify-center">
              <MemoryIcon />
            </div>
            <span className="mt-3 text-xs text-grov-accent font-mono">cloud</span>
          </div>

          {/* Line 2 */}
          <div
            className={`flex-1 max-w-16 md:max-w-24 h-px bg-grov-border transition-opacity duration-500 ${
              isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDelay: '400ms' }}
          />

          {/* Person 2 */}
          <div
            className={`flex flex-col items-center transition-opacity duration-500 ${
              isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ transitionDelay: '500ms' }}
          >
            <div className="w-14 h-[70px] md:w-16 md:h-20 text-grov-text-muted">
              <PersonSilhouette />
            </div>
            <span className="mt-2 text-xs text-grov-text-muted font-mono">dev-2</span>
          </div>
        </div>

        {/* Caption */}
        <p className="text-center mt-16 text-grov-text-muted text-sm max-w-md mx-auto">
          Memories sync to the cloud. Teammates get relevant context injected automatically—via proxy or MCP.
        </p>
      </div>
    </section>
  );
}
