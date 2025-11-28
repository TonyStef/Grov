import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://grov.dev',
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssMinify: true
    }
  }
});
