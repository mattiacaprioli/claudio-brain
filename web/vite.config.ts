import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In sviluppo il browser parla con Vite (5173) e il backend sta sulla 3000:
    // il proxy evita la CORS. In produzione il backend serve la build statica,
    // quindi stessa origine e nessun proxy necessario.
    proxy: {
      '/chat': 'http://localhost:3000',
    },
  },
});
