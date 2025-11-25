/**
 * Animated counter effect using Intersection Observer
 * Counters animate from start value to end value with easing
 */

interface CounterConfig {
  start: number;
  end: number;
  duration?: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function animateCounter(
  element: HTMLElement,
  config: CounterConfig
): void {
  const { start, end, duration = 1500, suffix = '', prefix = '', decimals = 0 } = config;
  const startTime = performance.now();

  const tick = (currentTime: number): void => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easedProgress = easeOutCubic(progress);
    const value = start + (end - start) * easedProgress;

    if (decimals > 0) {
      element.textContent = `${prefix}${value.toFixed(decimals)}${suffix}`;
    } else {
      element.textContent = `${prefix}${Math.round(value)}${suffix}`;
    }

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

export function initAnimatedCounters(): void {
  const counters = document.querySelectorAll<HTMLElement>('[data-counter]');

  if (counters.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement;
          const start = parseFloat(el.dataset.counterStart || '0');
          const end = parseFloat(el.dataset.counterEnd || '0');
          const duration = parseInt(el.dataset.counterDuration || '1500', 10);
          const suffix = el.dataset.counterSuffix || '';
          const prefix = el.dataset.counterPrefix || '';
          const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

          animateCounter(el, { start, end, duration, suffix, prefix, decimals });
          observer.unobserve(el);
        }
      });
    },
    {
      threshold: 0.5,
      rootMargin: '0px'
    }
  );

  counters.forEach((counter) => observer.observe(counter));
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnimatedCounters);
  } else {
    initAnimatedCounters();
  }
}
