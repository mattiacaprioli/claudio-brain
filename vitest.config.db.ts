import { defineConfig } from 'vitest/config';

/**
 * Configurazione separata per i test che toccano il Postgres vero
 * (`npm run test:db`, richiede `npm run db:up`).
 *
 * Stanno fuori da `npm test` di proposito: i test unitari devono girare in
 * mezzo secondo senza dipendenze esterne, quelli di integrazione servono a
 * dimostrare che il SQL funziona davvero — sono due mestieri diversi.
 */
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.db-spec.ts'],
    // Le suite condividono lo stesso database: eseguirle in parallelo
    // renderebbe i conteggi instabili.
    fileParallelism: false,
  },
});
