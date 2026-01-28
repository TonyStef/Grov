'use client';

import { useState, useEffect, useRef } from 'react';

const CASES = [
  {
    title: 'Teammate already solved it',
    description:
      'Dev A debugs the auth race condition on Monday. On Wednesday, Dev B asks Claude about a related token issue. Claude already knows — because Grov injected Dev A\'s reasoning.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128H5.228A2 2 0 015 19.128c0-1.113.285-2.16.786-3.07m0 0a9.337 9.337 0 014.121-.952c.926 0 1.81.148 2.625.372M12 9.75a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zm6-1.5a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    title: 'New dev joins the team',
    description:
      'Day one, their AI has the full institutional knowledge. Every architectural decision, every bug fix rationale, every "we tried X and it didn\'t work because Y." No ramp-up guessing.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
      </svg>
    ),
  },
  {
    title: 'You return to old code',
    description:
      'Six months later, you touch that payment module again. Your AI remembers every decision you made — why you chose Stripe over PayPal, why the retry logic uses exponential backoff.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

export default function UseCases() {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className={`py-28 px-6 transition-all duration-700 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
      }`}
    >
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <h2
            className="text-section-mobile md:text-section text-grov-text text-balance"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Memory that compounds
          </h2>
          <p className="mt-6 text-body-lg text-grov-text-secondary max-w-xl mx-auto">
            Every session makes the next one smarter — for everyone on the team.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {CASES.map((c, i) => (
            <div
              key={c.title}
              className="card group"
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(12px)',
                transition: `opacity 500ms ${i * 120}ms, transform 500ms ${i * 120}ms`,
              }}
            >
              <div className="w-10 h-10 rounded-xl bg-grov-accent/10 border border-grov-accent/20 flex items-center justify-center text-grov-accent mb-5">
                {c.icon}
              </div>
              <h3 className="text-grov-text font-semibold text-base mb-3" style={{ fontFamily: 'var(--font-display)' }}>
                {c.title}
              </h3>
              <p className="text-grov-text-secondary text-sm leading-relaxed">
                {c.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
