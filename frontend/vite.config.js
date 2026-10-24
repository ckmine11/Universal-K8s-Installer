import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
plugins: [react()],
    build: {
        rollupOptions: {
            output: {
                // a few stable library chunks (cached across deploys) instead of
                // one request per icon; three.js and xterm stay with their pages
                manualChunks(id) {
                    if (!id.includes('node_modules')) return
                    if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react'
                    if (id.includes('lucide-react')) return 'icons'
                    if (/framer-motion|motion-dom|motion-utils/.test(id)) return 'motion'
                }
            }
        }
    },
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true
            },
            '/ws': {
                target: 'ws://localhost:3000',
                ws: true
            }
        }
    }
})
