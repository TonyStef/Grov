import { useState, useEffect, useRef, useCallback, memo } from 'react';

// Types matching actual Grov data structures
interface ReasoningEntry {
  aspect: string;
  conclusion: string;
  insight?: string;
}

interface Decision {
  aspect: string;
  choice: string;
  reason: string;
}

interface MemoryPreview {
  id: string; // 8-char ID
  goal: string;
  summary: string;
}

interface ExpandedMemory {
  id: string;
  goal: string;
  originalQuery: string;
  reasoning: ReasoningEntry[];
  decisions: Decision[];
  filesTouched: string[];
}

interface PromptData {
  prompt: string;
  mode: 'cli' | 'mcp';  // cli = Claude Code proxy, mcp = IDE (Cursor/Zed)
  ide?: string;         // IDE name for MCP mode
  previews: MemoryPreview[];
  expandedMemories: ExpandedMemory[]; // Which ones Claude "chooses" to expand
}

// Demo data matching actual Grov memory structure
const PROMPTS: Record<string, PromptData> = {
  'auth': {
    prompt: 'fix auth logout bug',
    mode: 'cli',
    previews: [
      {
        id: '96937bd5',
        goal: 'Implement JWT validation flow',
        summary: 'JWT validation with 24h expiry, refresh tokens in Redis, RS256 signing...'
      },
      {
        id: '78c4a2e1',
        goal: 'Handle session invalidation',
        summary: 'Clear tokens before redirect, invalidate server-side, prevent race conditions...'
      },
      {
        id: 'a1b2c3d4',
        goal: 'Centralized auth error handling',
        summary: 'Unified error codes for auth failures, automatic retry on 401...'
      }
    ],
    expandedMemories: [
      {
        id: '78c4a2e1',
        goal: 'Handle session invalidation on logout',
        originalQuery: 'implement secure logout that clears all session state',
        reasoning: [
          {
            aspect: 'Token Lifecycle',
            conclusion: 'Must clear both access and refresh tokens',
            insight: 'Race condition if redirect happens before token clear'
          },
          {
            aspect: 'Server State',
            conclusion: 'Invalidate refresh token in Redis before response',
            insight: 'Prevents token reuse if intercepted'
          }
        ],
        decisions: [
          {
            aspect: 'Logout Flow',
            choice: 'Clear client tokens → API call → redirect',
            reason: 'Ensures tokens cleared even if API fails'
          }
        ],
        filesTouched: ['src/auth/session.ts', 'src/lib/tokens.ts']
      }
    ]
  },
  'rate-limit': {
    prompt: 'add rate limiting to API',
    mode: 'mcp',
    ide: 'Cursor',
    previews: [
      {
        id: 'e5f6g7h8',
        goal: 'Configure Redis connection pool',
        summary: 'Connection pooling with 10 max connections, 5s timeout, auto-reconnect...'
      },
      {
        id: 'i9j0k1l2',
        goal: 'API middleware architecture',
        summary: 'Express middleware chain order: auth → rate-limit → validation → handler...'
      },
      {
        id: 'm3n4o5p6',
        goal: 'Rate limiting algorithm decision',
        summary: 'Sliding window algorithm, 100 req/min per user, Redis-backed counters...'
      }
    ],
    expandedMemories: [
      {
        id: 'm3n4o5p6',
        goal: 'Implement rate limiting with sliding window',
        originalQuery: 'add rate limiting to prevent API abuse',
        reasoning: [
          {
            aspect: 'Algorithm Choice',
            conclusion: 'Sliding window provides smoother throttling than fixed window',
            insight: 'Prevents burst at window boundaries'
          },
          {
            aspect: 'Storage',
            conclusion: 'Use Redis sorted sets for O(1) operations',
            insight: 'ZREMRANGEBYSCORE for cleanup, ZCARD for count'
          }
        ],
        decisions: [
          {
            aspect: 'Rate Limit',
            choice: '100 requests per minute per user',
            reason: 'Balances protection with legitimate use patterns'
          }
        ],
        filesTouched: ['src/middleware/rate-limit.ts', 'src/lib/redis.ts']
      }
    ]
  },
  'tests': {
    prompt: 'write tests for payment flow',
    mode: 'cli',
    previews: [
      {
        id: 'q7r8s9t0',
        goal: 'Stripe webhook integration',
        summary: 'Webhook signature verification, idempotency keys, event deduplication...'
      },
      {
        id: 'u1v2w3x4',
        goal: 'Payment testing patterns',
        summary: 'stripe-mock for E2E, test mode API keys, webhook simulation...'
      },
      {
        id: 'y5z6a7b8',
        goal: 'Payment retry logic',
        summary: 'Exponential backoff on failure, max 3 retries, dead letter queue...'
      }
    ],
    expandedMemories: [
      {
        id: 'u1v2w3x4',
        goal: 'Set up payment flow testing infrastructure',
        originalQuery: 'how do we test Stripe payments without hitting production',
        reasoning: [
          {
            aspect: 'Mock Service',
            conclusion: 'stripe-mock Docker container for realistic responses',
            insight: 'Matches Stripe API exactly, no rate limits'
          },
          {
            aspect: 'Test Data',
            conclusion: 'Use Stripe test mode tokens (tok_visa, tok_visa_debit)',
            insight: '4242424242424242 triggers success, 4000000000000002 triggers decline'
          }
        ],
        decisions: [
          {
            aspect: 'Test Environment',
            choice: 'Docker Compose with stripe-mock service',
            reason: 'Isolated, reproducible, CI-compatible'
          }
        ],
        filesTouched: ['tests/payments.test.ts', 'docker-compose.test.yml']
      }
    ]
  }
};

const PROMPT_KEYS = ['auth', 'rate-limit', 'tests'] as const;
type PromptKey = typeof PROMPT_KEYS[number];

// Animation stages - updated to match real Grov flow
type Stage =
  | 'idle'
  | 'typing'
  | 'searching'      // Hybrid search running
  | 'preview'        // Show memory previews
  | 'reviewing'      // "Claude is reviewing..."
  | 'expanding'      // grov_expand tool call
  | 'complete';      // Show expanded memory

// Stage timing configuration (in ms)
const STAGE_DELAYS = {
  typing: 0,
  searching: 600,
  preview: 1400,
  reviewing: 2400,
  expanding: 3200,
  complete: 4000
} as const;

// Check for reduced motion preference
function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersReducedMotion;
}

// Intersection Observer hook for auto-play
function useIntersectionObserver(
  callback: () => void,
  options?: IntersectionObserverInit
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const hasTriggered = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !hasTriggered.current) {
            hasTriggered.current = true;
            callback();
          }
        });
      },
      { threshold: 0.3, ...options }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [callback, options]);

  return ref;
}

// Typing animation hook
function useTypingAnimation(
  text: string,
  isActive: boolean,
  reducedMotion: boolean
): string {
  const [displayText, setDisplayText] = useState('');

  useEffect(() => {
    if (!isActive) {
      setDisplayText('');
      return;
    }

    if (reducedMotion) {
      setDisplayText(text);
      return;
    }

    let index = 0;
    setDisplayText('');

    const interval = setInterval(() => {
      if (index < text.length) {
        setDisplayText(text.slice(0, index + 1));
        index++;
      } else {
        clearInterval(interval);
      }
    }, 40);

    return () => clearInterval(interval);
  }, [text, isActive, reducedMotion]);

  return displayText;
}

// Spinner component
function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      className={`inline-block w-4 h-4 border-2 border-grov-accent/30 border-t-grov-accent rounded-full ${className}`}
      style={{ animation: 'spin 1s linear infinite' }}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

// Memory Preview component (matches actual Grov preview format)
const MemoryPreviewCard = memo(function MemoryPreviewCard({
  preview,
  index,
  isVisible,
  reducedMotion
}: {
  preview: MemoryPreview;
  index: number;
  isVisible: boolean;
  reducedMotion: boolean;
}) {
  const delay = reducedMotion ? 0 : index * 100;

  return (
    <div
      className="font-mono text-sm break-words"
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(4px)',
        transitionProperty: 'opacity, transform',
        transitionDuration: reducedMotion ? '0ms' : '250ms',
        transitionDelay: `${delay}ms`,
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <span className="text-grov-accent">#{preview.id}</span>
      <span className="text-grov-text-muted">: "</span>
      <span className="text-grov-text">{preview.goal}</span>
      <span className="text-grov-text-muted">" → </span>
      <span className="text-grov-text-secondary">{preview.summary}</span>
    </div>
  );
});

// Expanded Memory component (matches actual grov_expand output)
const ExpandedMemoryCard = memo(function ExpandedMemoryCard({
  memory,
  isVisible,
  reducedMotion
}: {
  memory: ExpandedMemory;
  isVisible: boolean;
  reducedMotion: boolean;
}) {
  return (
    <div
      className="border border-grov-accent/30 rounded-2xl overflow-hidden bg-grov-surface-elevated/50 backdrop-blur-sm"
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(8px)',
        transitionProperty: 'opacity, transform',
        transitionDuration: reducedMotion ? '0ms' : '400ms',
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      {/* Header */}
      <div className="px-3 py-2 bg-grov-accent/10 border-b border-grov-accent/30">
        <span className="font-mono text-xs text-grov-accent font-medium">
          === VERIFIED PROJECT KNOWLEDGE ===
        </span>
      </div>

      <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 font-mono text-xs sm:text-sm">
        {/* Goal */}
        <div className="break-words">
          <span className="text-grov-accent font-medium">GOAL: </span>
          <span className="text-grov-text">{memory.goal}</span>
        </div>

        {/* Original Query */}
        <div className="break-words">
          <span className="text-grov-text-muted font-medium">ORIGINAL TASK: </span>
          <span className="text-grov-text-secondary">"{memory.originalQuery}"</span>
        </div>

        {/* Knowledge/Reasoning */}
        <div>
          <div className="text-grov-accent font-medium mb-2">KNOWLEDGE:</div>
          <div className="space-y-2 pl-2">
            {memory.reasoning.map((r, i) => (
              <div key={i} className="text-grov-text-secondary break-words">
                <span className="text-grov-text">• {r.conclusion}</span>
                {r.insight && (
                  <div className="pl-2 sm:pl-4 text-grov-text-muted">
                    → {r.insight}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Decisions */}
        <div>
          <div className="text-grov-accent font-medium mb-2">DECISIONS:</div>
          <div className="space-y-1 pl-2">
            {memory.decisions.map((d, i) => (
              <div key={i} className="text-grov-text-secondary break-words">
                <span className="text-grov-text">• {d.choice}</span>
                <span className="text-grov-text-muted"> ({d.reason})</span>
              </div>
            ))}
          </div>
        </div>

        {/* Files */}
        <div className="break-words">
          <span className="text-grov-accent font-medium">FILES: </span>
          <span className="text-grov-text-secondary">{memory.filesTouched.join(', ')}</span>
        </div>
      </div>
    </div>
  );
});

// Main Interactive Demo Component
interface InteractiveDemoProps {
  hideHeader?: boolean;
}

export default function InteractiveDemo({ hideHeader = false }: InteractiveDemoProps) {
  const [activePrompt, setActivePrompt] = useState<PromptKey>('auth');
  const [stage, setStage] = useState<Stage>('idle');
  const hasAutoPlayedRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  const timeoutsRef = useRef<NodeJS.Timeout[]>([]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach(clearTimeout);
    };
  }, []);

  // Clear all active timeouts
  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Run the animation sequence
  const runAnimation = useCallback(() => {
    clearTimeouts();

    if (reducedMotion) {
      setStage('complete');
      return;
    }

    setStage('typing');

    const stages: { stage: Stage; delay: number }[] = [
      { stage: 'searching', delay: STAGE_DELAYS.searching },
      { stage: 'preview', delay: STAGE_DELAYS.preview },
      { stage: 'reviewing', delay: STAGE_DELAYS.reviewing },
      { stage: 'expanding', delay: STAGE_DELAYS.expanding },
      { stage: 'complete', delay: STAGE_DELAYS.complete }
    ];

    stages.forEach(({ stage, delay }) => {
      const timeout = setTimeout(() => setStage(stage), delay);
      timeoutsRef.current.push(timeout);
    });
  }, [reducedMotion, clearTimeouts]);

  // Handle prompt button click
  const handlePromptClick = useCallback((key: PromptKey) => {
    setActivePrompt(key);
    setStage('idle');
    const timeout = setTimeout(() => runAnimation(), 50);
    timeoutsRef.current.push(timeout);
  }, [runAnimation]);

  // Handle reset/replay
  const handleReset = useCallback(() => {
    setStage('idle');
    const timeout = setTimeout(() => runAnimation(), 50);
    timeoutsRef.current.push(timeout);
  }, [runAnimation]);

  // Auto-play on scroll into view
  const handleIntersection = useCallback(() => {
    if (!hasAutoPlayedRef.current) {
      hasAutoPlayedRef.current = true;
      runAnimation();
    }
  }, [runAnimation]);

  const containerRef = useIntersectionObserver(handleIntersection);

  // Get current prompt data
  const promptData = PROMPTS[activePrompt];
  const typedText = useTypingAnimation(
    promptData.prompt,
    stage !== 'idle',
    reducedMotion
  );

  // Determine what to show based on stage
  const showTyping = stage !== 'idle';
  const showSearching = stage === 'searching';
  const showPreview = ['preview', 'reviewing', 'expanding', 'complete'].includes(stage);
  const showReviewing = stage === 'reviewing';
  const showExpanding = stage === 'expanding' || stage === 'complete';
  const showExpanded = stage === 'complete';

  // IDs that Claude "chooses" to expand
  const expandedIds = promptData.expandedMemories.map(m => m.id);

  return (
    <section
      ref={containerRef}
      className={hideHeader ? "" : "py-20 px-6"}
      aria-label="Interactive memory injection demo"
    >
      <div className={hideHeader ? "" : "max-w-4xl mx-auto"}>
        {/* Header - hidden when embedded in Hero */}
        {!hideHeader && (
          <div className="text-center mb-8">
            <h2
              className="text-section-mobile md:text-section text-grov-text mb-3"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              See memory injection
            </h2>
            <p className="text-grov-text-secondary text-subhead">
              Pick a prompt. Watch Grov find and inject relevant context.
            </p>
          </div>
        )}

        {/* Prompt Picker */}
        <div className={`flex flex-wrap items-center gap-2 ${hideHeader ? 'justify-start mb-3' : 'justify-center gap-2 sm:gap-3 mb-4 sm:mb-6'}`}>
          <span className={`text-grov-text-muted font-mono ${hideHeader ? 'text-xs' : 'text-xs sm:text-sm'} shrink-0`}>Try:</span>
          {PROMPT_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => handlePromptClick(key)}
              className={`
                rounded-lg font-mono transition-[color,background-color,border-color]
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grov-accent focus-visible:ring-offset-2 focus-visible:ring-offset-grov-black
                ${hideHeader ? 'px-2.5 sm:px-3 py-1.5 text-xs min-h-[36px]' : 'px-3 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm min-h-[44px]'}
                ${activePrompt === key
                  ? 'bg-grov-accent/20 text-grov-accent border border-grov-accent/40'
                  : 'bg-grov-surface border border-grov-border text-grov-text-secondary hover:border-grov-border-hover hover:text-grov-text'
                }
              `}
              style={{ touchAction: 'manipulation' }}
              aria-pressed={activePrompt === key}
            >
              {PROMPTS[key].prompt}
            </button>
          ))}
        </div>

        {/* Demo Terminal */}
        <div className="terminal">
          {/* Terminal Header */}
          <div className="terminal-header justify-between">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="flex gap-1.5 sm:gap-2" aria-hidden="true">
                <div className="terminal-dot terminal-dot-red" />
                <div className="terminal-dot terminal-dot-yellow" />
                <div className="terminal-dot terminal-dot-green" />
              </div>
              <span className="font-mono text-[10px] sm:text-xs text-grov-text-muted truncate max-w-[140px] sm:max-w-none">
                {promptData.mode === 'mcp' ? `${promptData.ide?.toLowerCase()} + grov mcp` : 'claude-code + grov'}
              </span>
            </div>

            <button
              onClick={handleReset}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-md text-xs font-mono text-grov-text-muted hover:text-grov-text hover:bg-grov-surface transition-[color,background-color] min-h-[40px] sm:min-h-[44px] min-w-[40px] sm:min-w-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grov-accent"
              style={{ touchAction: 'manipulation' }}
              aria-label="Replay animation"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span>Replay</span>
            </button>
          </div>

          {/* Terminal Content */}
          <div
            className="terminal-content min-h-[320px] sm:min-h-[400px] space-y-4"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            {/* User Prompt Line */}
            <div className="flex items-start gap-2 font-mono text-xs sm:text-sm">
              <span className="text-grov-accent shrink-0 mt-0.5" aria-hidden="true">&gt;</span>
              <span className="text-grov-text break-words min-w-0">
                {showTyping ? typedText : ''}
                {showTyping && stage === 'typing' && (
                  <span
                    className="inline-block w-1.5 sm:w-2 h-3 sm:h-4 bg-grov-accent ml-0.5 align-middle"
                    style={{ animation: 'blink 1s step-end infinite' }}
                    aria-hidden="true"
                  />
                )}
              </span>
            </div>

            {/* Searching State */}
            {showSearching && (
              <div
                className="text-xs sm:text-sm font-mono space-y-1"
                role="status"
                aria-live="polite"
              >
                {promptData.mode === 'mcp' ? (
                  <>
                    <div className="text-grov-text-muted break-words">
                      <span className="text-grov-text-secondary">[{promptData.ide?.toLowerCase()} → mcp]</span>
                      <span className="text-grov-accent ml-1 sm:ml-2">grov_preview</span>
                      <span className="text-grov-text-muted">(</span>
                    </div>
                    <div className="pl-2 sm:pl-4 text-grov-text break-words">
                      {`{ context: "${promptData.prompt}", mode: "agent" }`}
                    </div>
                    <div className="text-grov-text-muted">)</div>
                    <div className="flex items-center gap-2 mt-2 text-grov-text-secondary">
                      <Spinner />
                      <span>Searching team memory...</span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-grov-text-secondary flex-wrap">
                    <Spinner />
                    <span className="text-grov-text-muted">[grov]</span>
                    <span>Running hybrid search...</span>
                  </div>
                )}
              </div>
            )}

            {/* Preview State */}
            {showPreview && (
              <div className="space-y-2 sm:space-y-3">
                {/* Preview header */}
                <div
                  className="font-mono text-[10px] sm:text-xs text-grov-text-muted"
                  style={{
                    opacity: showPreview ? 1 : 0,
                    transitionProperty: 'opacity',
                    transitionDuration: reducedMotion ? '0ms' : '200ms'
                  }}
                >
                  [PROJECT KNOWLEDGE BASE: {promptData.previews.length} verified entries]
                </div>

                {/* Preview entries */}
                <div className="space-y-2 pl-2 border-l-2 border-grov-border text-xs sm:text-sm overflow-hidden">
                  {promptData.previews.map((preview, index) => (
                    <MemoryPreviewCard
                      key={preview.id}
                      preview={preview}
                      index={index}
                      isVisible={showPreview}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </div>

                {/* Hint text */}
                <div
                  className="font-mono text-[10px] sm:text-xs text-grov-text-muted italic"
                  style={{
                    opacity: showPreview ? 1 : 0,
                    transitionProperty: 'opacity',
                    transitionDuration: reducedMotion ? '0ms' : '200ms',
                    transitionDelay: reducedMotion ? '0ms' : '300ms'
                  }}
                >
                  {promptData.mode === 'mcp'
                    ? 'Call grov_expand with memory ID to get full knowledge.'
                    : 'Use grov_expand with these IDs to get full knowledge.'
                  }
                </div>
              </div>
            )}

            {/* Reviewing State */}
            {showReviewing && (
              <div
                className="flex items-center gap-2 text-xs sm:text-sm text-grov-text-secondary font-mono flex-wrap"
                role="status"
                aria-live="polite"
                style={{
                  opacity: showReviewing ? 1 : 0,
                  transitionProperty: 'opacity',
                  transitionDuration: reducedMotion ? '0ms' : '200ms'
                }}
              >
                <Spinner />
                <span className="text-grov-text-muted">
                  [{promptData.mode === 'mcp' ? promptData.ide?.toLowerCase() : 'claude'}]
                </span>
                <span>Reviewing context previews...</span>
              </div>
            )}

            {/* Expanding State - Tool Call */}
            {showExpanding && (
              <div
                className="space-y-2"
                style={{
                  opacity: showExpanding ? 1 : 0,
                  transitionProperty: 'opacity',
                  transitionDuration: reducedMotion ? '0ms' : '200ms'
                }}
              >
                <div className="font-mono text-xs sm:text-sm break-words">
                  <span className="text-grov-text-muted">
                    [{promptData.mode === 'mcp' ? `${promptData.ide?.toLowerCase()} → mcp` : 'claude → tool'}]
                  </span>
                  <span className="text-grov-accent ml-1 sm:ml-2">grov_expand</span>
                  <span className="text-grov-text-muted">(</span>
                  <span className="text-grov-text">
                    {promptData.mode === 'mcp'
                      ? `{ id: "${expandedIds[0]}" }`
                      : `{ ids: [${expandedIds.map(id => `"${id}"`).join(', ')}] }`
                    }
                  </span>
                  <span className="text-grov-text-muted">)</span>
                </div>
              </div>
            )}

            {/* Expanded Memory */}
            {showExpanded && (
              <div className="mt-4 space-y-4">
                {promptData.expandedMemories.map((memory) => (
                  <ExpandedMemoryCard
                    key={memory.id}
                    memory={memory}
                    isVisible={showExpanded}
                    reducedMotion={reducedMotion}
                  />
                ))}

                {/* Claude response indicator */}
                <div
                  className="font-mono text-xs sm:text-sm text-grov-text-secondary flex items-center gap-2"
                  style={{
                    opacity: showExpanded ? 1 : 0,
                    transitionProperty: 'opacity',
                    transitionDuration: reducedMotion ? '0ms' : '300ms',
                    transitionDelay: reducedMotion ? '0ms' : '400ms'
                  }}
                >
                  <span className="text-grov-accent shrink-0">✓</span>
                  <span className="break-words">
                    {promptData.mode === 'mcp'
                      ? `${promptData.ide} now has verified project context`
                      : 'Claude now has verified project context'
                    }
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Explainer */}
        <p className="text-center text-xs sm:text-sm text-grov-text-muted mt-4 sm:mt-6 font-mono px-2">
          ~500 tokens injected • No file exploration • Verified team knowledge
        </p>
      </div>

      {/* CSS for animations */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(0deg); }
          }

          @keyframes blink {
            0%, 100% { opacity: 1; }
          }
        }

        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border-width: 0;
        }
      `}</style>
    </section>
  );
}
