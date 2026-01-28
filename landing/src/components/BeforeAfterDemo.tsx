'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

type LeftStage =
  | 'idle'
  | 'typing'
  | 'reading-1'
  | 'reading-2'
  | 'reading-3'
  | 'reading-4'
  | 'reading-5'
  | 'reading-6'
  | 'exploring'
  | 'reading-7'
  | 'reading-8'
  | 'response'
  | 'done';

type RightStage =
  | 'idle'
  | 'typing'
  | 'searching'
  | 'previews'
  | 'expanding'
  | 'memory'
  | 'response'
  | 'done';

interface MemoryPreview {
  id: string;
  goal: string;
  summary: string;
}

// ── Static stage index maps (js-index-maps) ───────────────────────────────

const LEFT_STAGE_INDEX: Record<LeftStage, number> = {
  'idle': 0, 'typing': 1, 'reading-1': 2, 'reading-2': 3, 'reading-3': 4,
  'reading-4': 5, 'reading-5': 6, 'reading-6': 7, 'exploring': 8,
  'reading-7': 9, 'reading-8': 10, 'response': 11, 'done': 12,
};

const RIGHT_STAGE_INDEX: Record<RightStage, number> = {
  'idle': 0, 'typing': 1, 'searching': 2, 'previews': 3,
  'expanding': 4, 'memory': 5, 'response': 6, 'done': 7,
};

// ── Data ───────────────────────────────────────────────────────────────────

const PROMPT = 'add Stripe webhook for subscription upgrades';

const LEFT_FILES = [
  'src/payments/stripe.ts',
  'src/payments/webhooks.ts',
  'src/services/subscription.ts',
  'src/lib/stripe-client.ts',
  'src/config/billing.ts',
  'src/middleware/webhook-auth.ts',
  'src/models/plan.ts',
  'src/payments/events.ts',
];

const LEFT_RESPONSE = `I'll create a new webhook handler for subscription
upgrades. I'll set up signature verification and parse
the event payload. Let me scaffold a basic handler
that updates the user's plan in the database...`;

const RIGHT_PREVIEWS: MemoryPreview[] = [
  {
    id: '78c4a2e1',
    goal: 'Stripe webhook architecture',
    summary: 'Idempotency keys required, events must be deduplicated via event ID in Redis...',
  },
  {
    id: '96937bd5',
    goal: 'Subscription billing flow',
    summary: 'Plan changes queued until period end, proration handled by Stripe, sync DB after confirmation...',
  },
  {
    id: 'a1b2c3d4',
    goal: 'Webhook retry & error handling',
    summary: 'Exponential backoff on failure, dead letter queue after 3 retries, alert on DLQ...',
  },
];

const RIGHT_EXPANDED = {
  goal: 'Stripe webhook architecture',
  task: 'set up Stripe webhook pipeline with idempotency and error handling',
  knowledge: [
    {
      point: 'All webhook events must be deduplicated via event ID stored in Redis',
      insight: 'Stripe retries on 5xx — without dedup, upgrades get applied twice',
    },
    {
      point: 'Plan changes are queued until billing period end by default',
      insight: 'Use proration_behavior: "always_invoice" for immediate upgrades',
    },
  ],
  decision: 'Verify signature → check Redis for event ID → process → ACK',
  reason: 'Prevents duplicate processing and ensures exactly-once delivery',
  files: ['src/payments/webhooks.ts', 'src/services/subscription.ts'],
};

const RIGHT_RESPONSE = `Based on your team's existing webhook setup, I'll follow
the established pattern: verify signature, deduplicate via
Redis event ID, then process. Using "always_invoice" for
immediate upgrades since that's the team convention.`;

// ── Timing ─────────────────────────────────────────────────────────────────

const LEFT_TIMING: Record<LeftStage, number> = {
  'idle': 0, 'typing': 0,
  'reading-1': 800, 'reading-2': 1600, 'reading-3': 2200, 'reading-4': 2800,
  'reading-5': 3300, 'reading-6': 3700, 'exploring': 4200,
  'reading-7': 5200, 'reading-8': 5800, 'response': 7000, 'done': 8500,
};

const RIGHT_TIMING: Record<RightStage, number> = {
  'idle': 0, 'typing': 0,
  'searching': 800, 'previews': 1400, 'expanding': 2400,
  'memory': 3000, 'response': 4000, 'done': 5500,
};

// ── Hoisted static JSX (rendering-hoist-jsx) ──────────────────────────────

const SpinnerElement = (
  <div
    className="inline-block w-3.5 h-3.5 border-2 border-grov-accent/30 border-t-grov-accent rounded-full animate-ba-spin"
    role="status"
    aria-label="Loading"
  />
);

const RedSpinnerElement = (
  <div
    className="inline-block w-3.5 h-3.5 border-2 border-red-500/30 border-t-red-500 rounded-full animate-ba-spin"
    role="status"
    aria-label="Loading"
  />
);

const ReplayIcon = (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const TYPING_SPEED_MS = 35;
const VISIBILITY_THRESHOLD = 0;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mediaQuery.addEventListener('change', handler);

    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return reduced;
}

function useTypingAnimation(text: string, active: boolean, reduced: boolean): string {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    if (!active) {
      setDisplay('');
      return;
    }

    if (reduced) {
      setDisplay(text);
      return;
    }

    let currentIndex = 0;
    setDisplay('');

    const interval = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplay(text.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(interval);
      }
    }, TYPING_SPEED_MS);

    return () => clearInterval(interval);
  }, [text, active, reduced]);

  return display;
}

function useVisibility(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      { threshold: VISIBILITY_THRESHOLD }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return visible;
}

const COUNTER_INTERVAL_MS = 50;
const COUNTER_STEPS = 30;

function AnimCounter({ end, active, suffix = '' }: { end: number; active: boolean; suffix?: string }) {
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!active) {
      setVal(0);
      return;
    }

    let current = 0;
    const step = Math.max(1, Math.floor(end / COUNTER_STEPS));

    const interval = setInterval(() => {
      current += step;
      if (current >= end) {
        setVal(end);
        clearInterval(interval);
      } else {
        setVal(current);
      }
    }, COUNTER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [end, active]);

  return <>{val}{suffix}</>;
}

// ── Left Panel (Without Grov) ──────────────────────────────────────────────

const LeftPanel = memo(function LeftPanel({
  stage,
  typedText,
  reduced,
}: {
  stage: LeftStage;
  typedText: string;
  reduced: boolean;
}) {
  const current = LEFT_STAGE_INDEX[stage];
  const past = (s: LeftStage) => current >= LEFT_STAGE_INDEX[s];

  function getFilesShownCount(): number {
    const stages: LeftStage[] = ['reading-8', 'reading-7', 'reading-6', 'reading-5', 'reading-4', 'reading-3', 'reading-2', 'reading-1'];
    for (let i = 0; i < stages.length; i++) {
      if (past(stages[i])) {
        return 8 - i;
      }
    }
    return 0;
  }

  const filesShown = getFilesShownCount();

  const showExploring = past('exploring');
  const showResponse = past('response');
  const isDone = past('done');

  const tokenEstimate = Math.min(47, Math.round(filesShown * 5.5 + (showExploring ? 3 : 0)));

  return (
    <div className="terminal flex flex-col min-w-0" style={{ borderColor: 'rgba(239, 68, 68, 0.15)' }}>
      {/* Header */}
      <div className="terminal-header justify-between" style={{ borderColor: 'rgba(239, 68, 68, 0.1)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex gap-1.5 shrink-0" aria-hidden="true">
            <div className="terminal-dot terminal-dot-red" />
            <div className="terminal-dot terminal-dot-yellow" />
            <div className="terminal-dot terminal-dot-green" />
          </div>
          <span className="font-mono text-[10px] sm:text-xs text-grov-text-muted truncate">claude-code</span>
        </div>
        <span className="text-[10px] font-mono text-red-400/60 uppercase tracking-wider shrink-0">without grov</span>
      </div>

      {/* Content */}
      <div className="terminal-content flex-1 space-y-3 text-xs sm:text-sm min-h-[280px] sm:min-h-[420px] overflow-y-auto overflow-x-auto overscroll-contain touch-pan-x touch-pan-y">
        {/* Prompt */}
        <div className="flex items-start gap-2 font-mono min-w-0">
          <span className="text-grov-text-muted shrink-0" aria-hidden="true">&gt;</span>
          <span className="text-grov-text min-w-0 break-words">
            {stage !== 'idle' ? typedText : ''}
            {stage === 'typing' && (
              <span className="inline-block w-1.5 h-3.5 bg-grov-text-muted ml-0.5 align-middle animate-ba-blink" aria-hidden="true" />
            )}
          </span>
        </div>

        {/* File reads */}
        {filesShown > 0 && (
          <div className="space-y-1.5 font-mono">
            {LEFT_FILES.slice(0, filesShown).map((file) => (
              <div
                key={file}
                className="text-grov-text-muted flex items-center gap-2 min-w-0"
              >
                <span className="text-yellow-500/70 shrink-0">Reading</span>
                <span className="text-grov-text-secondary truncate min-w-0">{file}</span>
                <span className="text-grov-text-muted shrink-0">…</span>
              </div>
            ))}
          </div>
        )}

        {/* Explore agent */}
        {showExploring && !showResponse && (
          <div className="flex items-center gap-2 font-mono text-yellow-500/70">
            {RedSpinnerElement}
            <span>Spawning explore agent…</span>
          </div>
        )}

        {/* Live counters */}
        {filesShown > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] sm:text-xs text-grov-text-muted pt-2 border-t border-grov-border" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span>Files: <span className="text-red-400"><AnimCounter end={filesShown + (showExploring ? 4 : 0)} active={filesShown > 0} /></span></span>
            <span>Tokens: <span className="text-red-400"><AnimCounter end={tokenEstimate} active={filesShown > 0} suffix="K" /></span></span>
            <span>Time: <span className="text-red-400">{isDone ? '1:36' : showResponse ? '1:12' : showExploring ? '0:48' : `0:${String(filesShown * 5).padStart(2, '0')}`}</span></span>
          </div>
        )}

        {/* Response */}
        {showResponse && (
          <div className="mt-3 space-y-2">
            <div className="font-mono text-grov-text-muted text-[10px]">[claude response]</div>
            <div className="text-grov-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-words">
              {LEFT_RESPONSE}
            </div>
            {isDone && (
              <div className="flex items-center gap-2 text-red-400/80 font-mono text-[10px] sm:text-xs mt-2">
                <span>missed existing patterns — no idempotency, no dedup</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Right Panel (With Grov) ────────────────────────────────────────────────

const RightPanel = memo(function RightPanel({
  stage,
  typedText,
  reduced,
}: {
  stage: RightStage;
  typedText: string;
  reduced: boolean;
}) {
  const current = RIGHT_STAGE_INDEX[stage];
  const past = (s: RightStage) => current >= RIGHT_STAGE_INDEX[s];

  const showSearching = stage === 'searching';
  const showPreviews = past('previews');
  const showExpanding = past('expanding');
  const showMemory = past('memory');
  const showResponse = past('response');
  const isDone = past('done');

  return (
    <div className="terminal flex flex-col min-w-0" style={{ borderColor: 'rgba(52, 211, 153, 0.2)' }}>
      {/* Header */}
      <div className="terminal-header justify-between" style={{ borderColor: 'rgba(52, 211, 153, 0.1)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex gap-1.5 shrink-0" aria-hidden="true">
            <div className="terminal-dot terminal-dot-red" />
            <div className="terminal-dot terminal-dot-yellow" />
            <div className="terminal-dot terminal-dot-green" />
          </div>
          <span className="font-mono text-[10px] sm:text-xs text-grov-text-muted truncate">claude-code + grov</span>
        </div>
        <span className="text-[10px] font-mono text-grov-accent/60 uppercase tracking-wider shrink-0">with grov</span>
      </div>

      {/* Content */}
      <div className="terminal-content flex-1 space-y-3 text-xs sm:text-sm min-h-[280px] sm:min-h-[420px] overflow-y-auto overflow-x-auto overscroll-contain touch-pan-x touch-pan-y">
        {/* Prompt */}
        <div className="flex items-start gap-2 font-mono min-w-0">
          <span className="text-grov-accent shrink-0" aria-hidden="true">&gt;</span>
          <span className="text-grov-text min-w-0 break-words">
            {stage !== 'idle' ? typedText : ''}
            {stage === 'typing' && (
              <span className="inline-block w-1.5 h-3.5 bg-grov-accent ml-0.5 align-middle animate-ba-blink" aria-hidden="true" />
            )}
          </span>
        </div>

        {/* Searching */}
        {showSearching && (
          <div className="flex items-center gap-2 font-mono text-grov-text-secondary">
            {SpinnerElement}
            <span className="text-grov-text-muted">[grov]</span>
            <span>Searching team memory…</span>
          </div>
        )}

        {/* Previews */}
        {showPreviews && (
          <div className="space-y-2">
            <div className="font-mono text-[10px] text-grov-text-muted">
              [TEAM KNOWLEDGE: {RIGHT_PREVIEWS.length} memories found]
            </div>
            <div className="space-y-1.5 pl-2 border-l-2 border-grov-accent/20">
              {RIGHT_PREVIEWS.map((p, i) => (
                <div
                  key={p.id}
                  className="font-mono text-xs min-w-0 break-words"
                  style={{
                    opacity: 1,
                    transition: reduced ? 'none' : `opacity 200ms ${i * 80}ms`,
                  }}
                >
                  <span className="text-grov-accent">#{p.id}</span>
                  <span className="text-grov-text-muted">: &ldquo;</span>
                  <span className="text-grov-text">{p.goal}</span>
                  <span className="text-grov-text-muted">&rdquo; → </span>
                  <span className="text-grov-text-secondary">{p.summary}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Expand tool call */}
        {showExpanding && (
          <div className="font-mono text-xs min-w-0 break-words">
            <span className="text-grov-text-muted">[claude → tool]</span>
            <span className="text-grov-accent ml-2">grov_expand</span>
            <span className="text-grov-text-muted">(</span>
            <span className="text-grov-text">{`{ ids: ["78c4a2e1"] }`}</span>
            <span className="text-grov-text-muted">)</span>
          </div>
        )}

        {/* Expanded memory card */}
        {showMemory && (
          <div
            className="border border-grov-accent/30 rounded-xl overflow-hidden bg-grov-surface-elevated/50"
            style={{
              opacity: 1,
              transform: 'translateY(0)',
              transition: reduced ? 'none' : 'opacity 350ms, transform 350ms',
            }}
          >
            <div className="px-3 py-1.5 bg-grov-accent/10 border-b border-grov-accent/20">
              <span className="font-mono text-[10px] text-grov-accent font-medium">
                === VERIFIED PROJECT KNOWLEDGE ===
              </span>
            </div>
            <div className="p-3 space-y-2 font-mono text-[11px] sm:text-xs">
              <div className="break-words">
                <span className="text-grov-accent">GOAL: </span>
                <span className="text-grov-text">{RIGHT_EXPANDED.goal}</span>
              </div>
              <div>
                <span className="text-grov-accent">KNOWLEDGE:</span>
                <div className="pl-2 mt-1 space-y-1">
                  {RIGHT_EXPANDED.knowledge.map((k, i) => (
                    <div key={i} className="text-grov-text-secondary break-words">
                      <span className="text-grov-text">• {k.point}</span>
                      <div className="pl-3 text-grov-text-muted text-[10px]">→ {k.insight}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="break-words">
                <span className="text-grov-accent">DECISION: </span>
                <span className="text-grov-text">{RIGHT_EXPANDED.decision}</span>
                <span className="text-grov-text-muted"> ({RIGHT_EXPANDED.reason})</span>
              </div>
              <div className="break-words">
                <span className="text-grov-accent">FILES: </span>
                <span className="text-grov-text-secondary">{RIGHT_EXPANDED.files.join(', ')}</span>
              </div>
            </div>
          </div>
        )}

        {/* Live counters */}
        {showPreviews && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] sm:text-xs text-grov-text-muted pt-2 border-t border-grov-border" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span>Files: <span className="text-grov-accent">0</span></span>
            <span>Tokens: <span className="text-grov-accent">~500</span></span>
            <span>Time: <span className="text-grov-accent">{isDone ? '24s' : showResponse ? '18s' : showMemory ? '12s' : '6s'}</span></span>
          </div>
        )}

        {/* Response */}
        {showResponse && (
          <div className="mt-2 space-y-2">
            <div className="font-mono text-grov-text-muted text-[10px]">[claude response]</div>
            <div className="text-grov-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-words">
              {RIGHT_RESPONSE}
            </div>
            {isDone && (
              <div className="flex items-center gap-2 text-grov-accent font-mono text-[10px] sm:text-xs mt-1">
                <span aria-hidden="true">✓</span>
                <span>Used teammate&apos;s verified knowledge — no exploration needed</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Main Component ─────────────────────────────────────────────────────────

export default function BeforeAfterDemo() {
  const [leftStage, setLeftStage] = useState<LeftStage>('idle');
  const [rightStage, setRightStage] = useState<RightStage>('idle');
  const hasPlayedRef = useRef(false);
  const isVisibleRef = useRef(true);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pausedAtRef = useRef<{ left: LeftStage; right: RightStage; elapsed: number } | null>(null);
  const startTimeRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const isVisible = useVisibility(containerRef);

  const leftTyped = useTypingAnimation(PROMPT, leftStage !== 'idle', reduced);
  const rightTyped = useTypingAnimation(PROMPT, rightStage !== 'idle', reduced);

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  useEffect(() => () => clearTimeouts(), [clearTimeouts]);

  const scheduleStages = useCallback((offsetMs = 0) => {
    clearTimeouts();

    const leftStages: LeftStage[] = ['reading-1', 'reading-2', 'reading-3', 'reading-4', 'reading-5', 'reading-6', 'exploring', 'reading-7', 'reading-8', 'response', 'done'];
    const rightStages: RightStage[] = ['searching', 'previews', 'expanding', 'memory', 'response', 'done'];

    leftStages.forEach((s) => {
      const delay = LEFT_TIMING[s] - offsetMs;
      if (delay > 0) {
        const t = setTimeout(() => setLeftStage(s), delay);
        timeoutsRef.current.push(t);
      }
    });

    rightStages.forEach((s) => {
      const delay = RIGHT_TIMING[s] - offsetMs;
      if (delay > 0) {
        const t = setTimeout(() => setRightStage(s), delay);
        timeoutsRef.current.push(t);
      }
    });
  }, [clearTimeouts]);

  const run = useCallback(() => {
    clearTimeouts();
    pausedAtRef.current = null;
    startTimeRef.current = Date.now();

    if (reduced) {
      setLeftStage('done');
      setRightStage('done');
      return;
    }

    setLeftStage('typing');
    setRightStage('typing');
    scheduleStages(0);
  }, [reduced, clearTimeouts, scheduleStages]);

  // Pause when scrolled out of view, resume when back
  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;

    // Both done — nothing to pause/resume
    if (leftStage === 'done' && rightStage === 'done') return;
    if (leftStage === 'idle' && rightStage === 'idle') return;

    if (!isVisible && wasVisible) {
      // Scrolled away — pause
      const elapsed = Date.now() - startTimeRef.current;
      clearTimeouts();
      pausedAtRef.current = { left: leftStage, right: rightStage, elapsed };
    } else if (isVisible && !wasVisible && pausedAtRef.current) {
      // Scrolled back — resume from where we left off
      const { elapsed } = pausedAtRef.current;
      startTimeRef.current = Date.now() - elapsed;
      scheduleStages(elapsed);
      pausedAtRef.current = null;
    }
  }, [isVisible, leftStage, rightStage, clearTimeouts, scheduleStages]);

  const handleReplay = useCallback(() => {
    setLeftStage('idle');
    setRightStage('idle');
    const t = setTimeout(() => run(), 80);
    timeoutsRef.current.push(t);
  }, [run]);

  // Auto-play on first scroll into view
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !hasPlayedRef.current) {
          hasPlayedRef.current = true;
          run();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [run]);

  return (
    <section ref={containerRef} className="py-20 px-6" aria-label="Before and after demo">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-6">
          <h2
            className="text-section-mobile md:text-section text-grov-text text-balance"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Same prompt. Different outcome.
          </h2>
        </div>

        {/* Replay button */}
        <div className="flex justify-end mb-3">
          <button
            onClick={handleReplay}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono text-grov-text-muted hover:text-grov-text hover:bg-grov-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grov-accent focus-visible:ring-offset-2 focus-visible:ring-offset-grov-black"
            style={{ touchAction: 'manipulation' }}
            aria-label="Replay demo"
          >
            {ReplayIcon}
            <span>Replay</span>
          </button>
        </div>

        {/* Side-by-side panels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          <LeftPanel stage={leftStage} typedText={leftTyped} reduced={reduced} />
          <RightPanel stage={rightStage} typedText={rightTyped} reduced={reduced} />
        </div>

        {/* Caption */}
        <p className="text-center mt-8 text-grov-text-secondary text-sm sm:text-base font-medium">
          Your teammate already built the Stripe pipeline. <span className="text-grov-accent">With Grov, your AI builds on top of it.</span>
        </p>
      </div>
    </section>
  );
}
