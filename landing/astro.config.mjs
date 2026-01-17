import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';

// Fetch version from npm registry at build time
async function getPublishedVersion() {
  try {
    const res = await fetch('https://registry.npmjs.org/grov/latest');
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();
    return data.version;
  } catch {
    // Fallback if npm is unreachable
    return '0.0.0';
  }
}

const APP_VERSION = await getPublishedVersion();

export default defineConfig({
  site: 'https://grov.dev',
  integrations: [mdx(), react()],
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssMinify: true
    },
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION)
    }
  }
});
