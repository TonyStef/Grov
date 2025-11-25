/**
 * Scroll-triggered reveal animations using Intersection Observer
 * Sections scale from 0.95 -> 1.0 + fade in when entering viewport
 */

export function initScrollReveals(): void {
  const sections = document.querySelectorAll<HTMLElement>('.reveal-section');

  if (sections.length === 0) return;

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
