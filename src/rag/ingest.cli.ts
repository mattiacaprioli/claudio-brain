// Entry point CLI dell'ingestion: npm run rag:ingest
//
// Sta in `src/` e non in `db/` per un motivo concreto: importa AppModule, e
// con `module: nodenext` gli import interni devono finire in `.js`. Node sa
// eseguire un `.ts` direttamente (type stripping), ma NON riscrive `.js` in
// `.ts` negli import: cercherebbe `src/app.module.js`, che non esiste.
// Stando in `src/` viene compilato da `nest build` come tutto il resto, e si
// esegue dal `dist/` — dove i `.js` esistono per davvero.
//
// Usa `createApplicationContext` (contesto Nest senza server HTTP) così riusa
// gli stessi provider dell'applicazione — pool Postgres, configurazione,
// provider di embedding — invece di ricostruirseli e andare fuori sincrono.

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider.js';
import { DEFAULT_TARGETS, ingest } from './ingest.js';
import { RagRepository } from './rag.repository.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const repository = app.get(RagRepository);
    const embeddings = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    console.log(
      `Ingestion con ${embeddings.model} (${embeddings.dimensions} dimensioni)\n`,
    );

    const result = await ingest(process.cwd(), DEFAULT_TARGETS, {
      repository,
      embeddings,
      log: (message) => console.log(message),
    });

    console.log(
      `\nFile analizzati: ${result.filesScanned} · indicizzati: ${result.filesIndexed} ` +
        `· invariati o vuoti: ${result.filesSkipped}`,
    );
    console.log(
      `Chunk creati: ${result.chunksCreated} · token stimati: ${result.tokensEstimated}`,
    );

    const stats = await repository.stats();
    if (stats.length > 0) {
      console.log('\nIndice attuale:');
      for (const row of stats) {
        console.log(
          `  ${row.source.padEnd(10)} ${String(row.chunks).padStart(5)} chunk ` +
            `in ${row.files} file (${row.model})`,
        );
      }
    }
  } finally {
    await app.close();
  }
}

await main();
