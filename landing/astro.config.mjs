import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://grov.dev',
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssMinify: true
    }
  }
});
