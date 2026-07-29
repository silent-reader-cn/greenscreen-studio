import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',  // 打包后用 file:// 或 express 静态服务都需要相对路径
  plugins: [react()],
  server: {
    host: true, // 允许手机局域网访问
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
})
