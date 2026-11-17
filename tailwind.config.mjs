/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      // Same tokens as pavelnovel.com: every colour is a CSS variable so the
      // theme swaps without a class changing. See src/styles/global.css.
      colors: {
        page: 'var(--bg)',
        surface: 'var(--surface)',
        wash: 'var(--wash)',
        rule: 'var(--rule)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        doc: '46rem',
        sheet: '62rem',
      },
      transitionTimingFunction: {
        doc: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
