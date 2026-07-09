import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://localhost:20006'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
})
