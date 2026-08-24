import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'https://api.topsters.org',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  test: {
    // Mindmap logic (ops, history, layout, geometry) is pure TypeScript with
    // no DOM access by design (MINDMAP_NATIVE_AGENT_BRIEF §0.5), so the suite
    // runs in node and jsdom is never needed.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
