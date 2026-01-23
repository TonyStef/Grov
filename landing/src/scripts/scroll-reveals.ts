/**
 * Scroll-triggered reveal animations using Intersection Observer
 * Sections translate Y + fade in when entering viewport
 * Respects prefers-reduced-motion
 */

export function initScrollReveals(): void {
  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sections = document.querySelectorAll<HTMLElement>('.reveal-section');

  if (sections.length === 0) return;

  // If user prefers reduced motion, show all sections immediately
  if (prefersReducedMotion) {
    sections.forEach((section) => {
      section.classList.add('in-view');
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          // Unobserve after animation to save resources
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    }
  );

  sections.forEach((section) => observer.observe(section));
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollReveals);
  } else {
    initScrollReveals();
  }
}
