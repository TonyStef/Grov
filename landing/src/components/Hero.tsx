'use client';

import { useState, useEffect } from 'react';

const FADE_IN_DELAY_MS = 50;
const BADGE_DELAY_MS = 0;
const HEADLINE_DELAY_MS = 100;
const SUBHEADLINE_DELAY_MS = 200;
const CTA_DELAY_MS = 300;

export default function Hero() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), FADE_IN_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const fadeInClass = isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6';

  return (
    <section className="min-h-[80vh] flex items-center pt-28 pb-16 px-6">
      <div className="max-w-4xl mx-auto w-full text-center">
        <div className={`inline-flex items-center transition-opacity duration-500 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
          <span className="text-grov-text-muted text-sm tracking-wide">
            <span className="text-grov-accent font-medium">//</span>
            {' '}The First "Multiplayer AI" Workflow That Actually Scales.
          </span>
        </div>

        <h1
          className={`mt-8 text-hero-mobile md:text-hero text-grov-text text-balance transition-all duration-700 ${fadeInClass}`}
          style={{ fontFamily: 'var(--font-display)', transitionDelay: `${HEADLINE_DELAY_MS}ms` }}
        >
          Your team's AI agents<br />
          don't communicate.<br />
          <span className="text-grov-accent">We fix that.</span>
        </h1>

        <p
          className={`mt-8 text-subhead text-grov-text-secondary max-w-2xl mx-auto text-pretty transition-all duration-700 ${fadeInClass}`}
          style={{ transitionDelay: `${SUBHEADLINE_DELAY_MS}ms` }}
        >
          Grov gives your engineering team a shared, persistent AI memory. Decisions, bugs, architecture — captured automatically from every session and injected into the next one that needs it.
        </p>

        <div
          className={`mt-10 flex flex-col sm:flex-row gap-4 justify-center transition-all duration-700 ${fadeInClass}`}
          style={{ transitionDelay: `${CTA_DELAY_MS}ms` }}
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
    </section>
  );
}
