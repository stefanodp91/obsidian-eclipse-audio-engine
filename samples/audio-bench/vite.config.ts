import { defineConfig } from 'vite';

export default defineConfig({
  base: '/obsidian-eclipse-audio-engine/',
  server: { port: 4173 },
  build: { target: 'es2022' },
});
