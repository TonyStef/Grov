/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Background colors
        'grov-black': '#09090b',
        'grov-surface': '#18181b',
        'grov-surface-elevated': '#27272a',
        'grov-border': '#3f3f46',

        // Text colors
        'grov-text': '#fafafa',
        'grov-text-secondary': '#a1a1aa',
        'grov-text-muted': '#71717a',

        // Accent colors
        'grov-accent': '#10b981',
        'grov-accent-hover': '#34d399',
      },
      fontFamily: {
        'sans': ['Satoshi', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Custom type scale
        'hero': ['4.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
        'hero-mobile': ['3rem', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '700' }],
        'section': ['3rem', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '700' }],
        'section-mobile': ['2rem', { lineHeight: '1.25', letterSpacing: '-0.02em', fontWeight: '700' }],
        'subhead': ['1.5rem', { lineHeight: '1.4', fontWeight: '400' }],
        'body-lg': ['1.125rem', { lineHeight: '1.75' }],
        'body': ['1rem', { lineHeight: '1.625' }],
        'small': ['0.875rem', { lineHeight: '1.5' }],
        'code': ['0.875rem', { lineHeight: '1.7' }],
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-out forwards',
        'fade-in-up': 'fadeInUp 0.6s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
