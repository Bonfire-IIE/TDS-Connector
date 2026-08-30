import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 连接器门户前端 dev server 监听 0.0.0.0:5273（避免与平台前端 5173 冲突；host 网络下宿主机可直接访问）
// /portal 与 /api 反代到本地门户开发后端。
// 注：也可用 VITE_PORTAL_API 直接指定后端绝对地址（见 src/api/client.ts），此时可不依赖 proxy。
export default defineConfig({
  plugins: [react()],
  // Avoid permission coupling with node_modules when dependencies were installed
  // by a container or another user in the shared development workspace.
  cacheDir: `/tmp/bonfire-connector-portal-vite-${process.pid}`,
  server: {
    host: '0.0.0.0',
    port: 5273,
    proxy: {
      '/portal': {
        target: process.env.PORTAL_DEV_BACKEND ?? 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
      '/api': {
        target: process.env.PORTAL_DEV_BACKEND ?? 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
    },
  },
})
