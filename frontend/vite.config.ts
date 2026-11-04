import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { freeDrawingReplayPlugin } from './freeDrawingReplayPlugin'
export default defineConfig({ plugins: [react(), freeDrawingReplayPlugin()], server: { port: 5173 }, test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', coverage: { include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'], thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 } } } })
