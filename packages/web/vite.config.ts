import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';
const DEV_PORT = parseInt(process.env.DEV_PORT ?? '5173', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_PORT,
    proxy: {
      '/api': BACKEND_URL,
      '/ws': {
        target: BACKEND_URL,
        ws: true,
      },
    },
  },
});
