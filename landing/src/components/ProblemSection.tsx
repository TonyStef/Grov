'use client';

import { useState, useEffect, useRef } from 'react';
import AnimatedCounter from './AnimatedCounter';

// Hoisted static SVG (rendering-hoist-jsx)
const ArrowIcon = (
  <svg className="w-4 h-4 ml-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

export default function ProblemSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // Intersection Observer for reveal animation
  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    // Check reduced motion preference
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
      { threshold: 0.1, rootMargin: '0px' }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className={`py-24 px-6 transition-all duration-700 ${
        isVisible
          ? 'opacity-100 translate-y-0 scale-100'
          : 'opacity-0 translate-y-5 scale-[0.96]'
      }`}
    >
      <div className="max-w-5xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-section-mobile md:text-section text-grov-text">
            The problem
          </h2>
          <p className="mt-6 text-body-lg text-grov-text-secondary max-w-2xl mx-auto text-balance">
            Every session, Claude re-explores your codebase.<br />
            It reads the same files. Rediscovers the same patterns.<br />
            You burn tokens on redundant exploration.
          </p>
        </div>

        {/* Comparison cards */}
        <div className="grid md:grid-cols-2 gap-6 mt-12">
          {/* Without grov */}
          <div className="card">
            <div className="text-sm font-medium text-grov-text-muted uppercase tracking-wider mb-6">
              Without grov
            </div>

            <div className="space-y-4">
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Response time</span>
                <span className="text-grov-text font-medium font-mono">
                  1:<AnimatedCounter start={0} end={36} duration={1200} />
                </span>
              </div>
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Token usage</span>
                <span className="text-grov-text font-medium">
                  +<AnimatedCounter start={0} end={1} duration={1200} />% per prompt
                </span>
              </div>
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Explore agents</span>
                <span className="text-grov-text font-medium">
                  <AnimatedCounter start={0} end={3} duration={1200} />+
                </span>
              </div>
              <div className="flex justify-between items-center py-3">
                <span className="text-grov-text-secondary">Files read</span>
                <span className="text-grov-text font-medium">
                  <AnimatedCounter start={0} end={10} duration={1200} />+
                </span>
              </div>
            </div>
          </div>

          {/* With grov */}
          <div className="card card-highlight">
            <div className="flex items-center justify-between mb-6">
              <div className="text-sm font-medium text-grov-accent uppercase tracking-wider">
                With grov
              </div>
              <div className="px-2 py-1 bg-grov-accent/20 border border-grov-accent/30 rounded text-xs font-bold text-grov-accent">
                4x faster
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Response time</span>
                <span className="text-grov-accent font-medium font-mono">
                  <AnimatedCounter start={96} end={24} duration={1500} />s
                </span>
              </div>
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Token usage</span>
                <span className="text-grov-accent font-medium">
                  ~0%
                </span>
              </div>
              <div className="flex justify-between items-center py-3 border-b border-grov-border">
                <span className="text-grov-text-secondary">Explore agents</span>
                <span className="text-grov-accent font-medium">
                  <AnimatedCounter start={3} end={0} duration={1500} />
                </span>
              </div>
              <div className="flex justify-between items-center py-3">
                <span className="text-grov-text-secondary">Files read</span>
                <span className="text-grov-accent font-medium">
                  <AnimatedCounter start={10} end={0} duration={1500} />
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* How it saves tokens */}
        <div className="card p-8 mt-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <h3 className="text-lg font-bold text-grov-text mb-3">How Grov saves tokens</h3>
              <p className="text-grov-text-secondary text-sm mb-4">
                Semantic search finds relevant memories, shows lightweight previews, expands only what's needed.
              </p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-grov-accent">1.</span>
                    <span className="text-grov-text-secondary">Preview: 3-5 memories x ~100 tokens</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-grov-accent">2.</span>
                    <span className="text-grov-text-secondary">Expand on demand: ~500-1K tokens each</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-grov-accent">3.</span>
                    <span className="text-grov-text-secondary">Worst case (all 5): ~5-7K tokens</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-grov-text-muted">vs.</span>
                    <span className="text-grov-text-secondary">Manual exploration: 50K+ tokens</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="shrink-0">
              <a href="/docs/how-memory-works" className="btn-secondary text-sm">
                Learn how it works
                {ArrowIcon}
              </a>
            </div>
          </div>
        </div>

        {/* Bottom note */}
        <p className="text-center mt-12 text-grov-text-muted text-small">
          Measured on real Claude Code sessions. Results may vary based on codebase complexity.
        </p>
      </div>
    </section>
  );
}
