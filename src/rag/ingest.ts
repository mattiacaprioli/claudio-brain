import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { glob } from 'node:fs/promises';
import type { Chunk } from './chunking/chunk.js';
import { chunkMarkdown } from './chunking/markdown.chunker.js';
import { chunkTypeScript } from './chunking/typescript.chunker.js';
import { estimateTokens, type EmbeddingProvider } from './embedding.provider.js';
import type { RagRepository } from './rag.repository.js';

export interface IngestTarget {
  /** Etichetta della sorgente: 'code' | 'docs' | 'hardware'. */
  source: string;
  /** Pattern glob relativi alla root, es. 'src/**\/*.ts'. */
  patterns: string[];
}

export interface IngestResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  tokensEstimated: number;
}

/** Sorgenti di default: il codice del progetto e la documentazione. */
export const DEFAULT_TARGETS: IngestTarget[] = [
  { source: 'code', patterns: ['src/**/*.ts', 'db/**/*.ts', 'db/**/*.sql'] },
  { source: 'docs', patterns: ['*.md', 'docs/**/*.md'] },
  // Per il robot: appoggia qui pinout, datasheet e note di cablaggio.
  { source: 'hardware', patterns: ['hardware/**/*.md'] },
];

/**
 * Pipeline di ingestion, in tre fasi.
 *
 *   1. SCANSIONE  — legge e spezza tutti i file, calcola gli hash, decide
 *                   quali file sono cambiati. Nessuna chiamata di rete.
 *   2. EMBEDDING  — una sola chiamata con TUTTI i chunk di TUTTI i file.
 *   3. SCRITTURA  — riassegna i vettori ai file e scrive, un file alla volta.
 *
 * Perché non un file per volta (come faceva la prima versione): il rate limit
 * si conta in RICHIESTE al minuto, e il piano gratuito di Voyage ne concede
 * tre. Chiamando l'API una volta per file, 31 file diventano 31 richieste —
 * oltre dieci minuti di attesa, e la maggior parte di quelle richieste
 * trasporta poche centinaia di token. Passando tutto insieme, il provider
 * riempie ogni richiesta fino al tetto consentito e le richieste diventano
 * il minimo indispensabile. **Il confine del batch deve essere il rate limit,
 * non il file.**
 *
 * È scritta come funzione pura sulle sue dipendenze (repository e provider
 * passati come argomenti) invece che come service Nest: così la si può
 * testare con un provider finto che restituisce vettori sintetici, senza key
 * e senza spendere nulla.
 */
export async function ingest(
  root: string,
  targets: IngestTarget[],
  deps: {
    repository: RagRepository;
    embeddings: EmbeddingProvider;
    log?: (message: string) => void;
  },
): Promise<IngestResult> {
  const log = deps.log ?? (() => {});
  const result: IngestResult = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    tokensEstimated: 0,
  };

  // --- FASE 1: scansione, senza rete ------------------------------------
  const pending: Array<{
    source: string;
    path: string;
    chunks: Array<Chunk & { contentHash: string }>;
  }> = [];

  for (const target of targets) {
    for await (const absolutePath of glob(target.patterns, { cwd: root })) {
      const fullPath = resolve(root, absolutePath);
      const info = await stat(fullPath).catch(() => null);
      if (!info?.isFile()) continue;

      result.filesScanned += 1;
      const relativePath = relative(root, fullPath);
      const text = await readFile(fullPath, 'utf8');

      const chunks = chunkFile(relativePath, text, target.source);
      if (chunks.length === 0) {
        result.filesSkipped += 1;
        continue;
      }

      // INGESTION INCREMENTALE: se gli hash dei chunk sono identici a quelli
      // già indicizzati, il file non è cambiato e non serve ricalcolare nulla.
      // Su un file da 30 chunk sono 30 embedding risparmiati ad ogni run.
      const hashed = chunks.map((chunk) => ({
        ...chunk,
        contentHash: hashContent(chunk.content),
      }));
      const existing = await deps.repository.findExistingHashes(
        target.source,
        relativePath,
      );
      const unchanged =
        existing.size === hashed.length &&
        hashed.every((chunk) => existing.has(chunk.contentHash));

      if (unchanged) {
        result.filesSkipped += 1;
        log(`  invariato   ${relativePath} (${hashed.length} chunk)`);
        continue;
      }

      pending.push({ source: target.source, path: relativePath, chunks: hashed });
    }
  }

  if (pending.length === 0) return result;

  // --- FASE 2: embedding di tutto in un colpo ----------------------------
  const allChunks = pending.flatMap((file) => file.chunks);
  const totalTokens = allChunks.reduce(
    (total, chunk) => total + estimateTokens(chunk.content),
    0,
  );
  log(
    `\n${pending.length} file da indicizzare · ${allChunks.length} chunk · ` +
      `~${totalTokens} token\n`,
  );

  // input_type: 'document' — questi testi vanno nell'indice, non sono domande.
  const vectors = await deps.embeddings.embed(
    allChunks.map((chunk) => chunk.content),
    'document',
  );

  if (vectors.length !== allChunks.length) {
    throw new Error(
      `Disallineamento embedding: ${vectors.length} vettori per ` +
        `${allChunks.length} chunk.`,
    );
  }

  // --- FASE 3: scrittura, un file alla volta -----------------------------
  // I vettori tornano nello stesso ordine dei testi inviati, quindi si
  // riassegnano scorrendo un offset. È l'unico punto delicato di questa
  // riorganizzazione: se l'ordine non fosse garantito, ogni chunk finirebbe
  // con il vettore di un altro — nessun errore, solo risposte assurde.
  // (Il provider riordina per `index` proprio per garantirlo.)
  let offset = 0;
  for (const file of pending) {
    const slice = vectors.slice(offset, offset + file.chunks.length);
    offset += file.chunks.length;

    await deps.repository.replaceFileChunks(
      file.source,
      file.path,
      file.chunks.map((chunk, index) => ({ ...chunk, embedding: slice[index] })),
      deps.embeddings.model,
    );

    result.filesIndexed += 1;
    result.chunksCreated += file.chunks.length;
    log(`  indicizzato ${file.path} (${file.chunks.length} chunk)`);
  }
  result.tokensEstimated = totalTokens;

  return result;
}

/** Sceglie il chunker in base all'estensione. */
export function chunkFile(path: string, text: string, source: string): Chunk[] {
  if (path.endsWith('.md')) {
    return chunkMarkdown(path, text, { source });
  }
  if (path.endsWith('.ts') || path.endsWith('.tsx')) {
    return chunkTypeScript(path, text, { source });
  }
  // SQL e tutto il resto: un file per chunk, sono corti e coesi.
  const lines = text.split('\n');
  return text.trim().length === 0
    ? []
    : [
        {
          source,
          path,
          startLine: 1,
          endLine: lines.length,
          symbol: null,
          content: text,
        },
      ];
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}
