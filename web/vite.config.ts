import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: {
    // Perché non basta leggere `import.meta.env.VITE_REPLAY` direttamente:
    // Vite sostituisce quell'espressione con un valore letterale SOLO se la
    // variabile è definita. Quando non lo è — cioè in ogni build del kiosk —
    // resta un accesso a un oggetto, quindi un valore che si conosce solo a
    // runtime: Rollup non può dimostrare che il ramo della demo è morto, e si
    // porta dentro il modulo di replay con le sue registrazioni.
    //
    // Definendola sempre, `isReplay` diventa una costante `false` e l'intero
    // ramo — JSON compreso — esce dal bundle: 380 → 370 KB, e del contenuto
    // delle registrazioni non resta traccia nel file prodotto.
    //
    // Da solo non basta: serve anche che il modulo di replay non faccia
    // calcoli a livello di modulo, o Rollup lo tiene comunque (vedi replay.ts).
    'import.meta.env.VITE_REPLAY': JSON.stringify(process.env.VITE_REPLAY ?? ''),
  },
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
