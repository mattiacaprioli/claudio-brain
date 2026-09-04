import type { EmbeddingProvider } from './embedding.provider.js';
import { chunkFile, ingest, type IngestTarget } from './ingest.js';
import type { RagRepository } from './rag.repository.js';

/** Provider finto: vettori deterministici, nessuna chiamata di rete, costo zero. */
function fakeProvider(dimensions = 8): EmbeddingProvider & { calls: number } {
  return {
    model: 'fake-model',
    dimensions,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((text) =>
        Array.from({ length: dimensions }, (_, i) => (text.length + i) / 100),
      );
    },
  } as EmbeddingProvider & { calls: number };
}

function fakeRepository(existing: Record<string, Set<string>> = {}) {
  const saved: Array<{ path: string; chunks: number }> = [];
  return {
    saved,
    repository: {
      findExistingHashes: async (_source: string, path: string) =>
        existing[path] ?? new Set<string>(),
      replaceFileChunks: async (
        _source: string,
        path: string,
        chunks: unknown[],
      ) => {
        saved.push({ path, chunks: chunks.length });
      },
    } as unknown as RagRepository,
  };
}

describe('chunkFile', () => {
  it('sceglie il chunker in base all estensione', () => {
    expect(chunkFile('a.md', '# Titolo\n\ntesto', 'docs')[0].symbol).toBe('Titolo');
    expect(chunkFile('a.ts', 'export const x = 1;', 'code')[0].symbol).toBe('x');
  });

  it('per SQL e altri formati fa un chunk per file', () => {
    const chunks = chunkFile('001.sql', 'create table t (id int);', 'code');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBeNull();
  });

  it('ignora i file vuoti', () => {
    expect(chunkFile('vuoto.sql', '   \n  ', 'code')).toEqual([]);
  });
});

describe('ingest', () => {
  const targets: IngestTarget[] = [{ source: 'code', patterns: ['src/**/*.ts'] }];

  it('indicizza i file trovati e conta i chunk', async () => {
    const { repository, saved } = fakeRepository();
    const embeddings = fakeProvider();

    const result = await ingest(process.cwd(), targets, { repository, embeddings });

    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(saved.length).toBe(result.filesIndexed);
  });

  it('chiama gli embedding UNA volta per tutti i file, non una per file', async () => {
    const { repository, saved } = fakeRepository();
    const embeddings = fakeProvider();

    await ingest(process.cwd(), targets, { repository, embeddings });

    // Il rate limit si conta in richieste al minuto (3 sul piano gratuito
    // Voyage): una chiamata per file trasformerebbe 31 file in 31 richieste,
    // cioè oltre dieci minuti. Il raggruppamento in batch è compito del
    // provider, ma solo se gli passiamo tutto insieme.
    expect(saved.length).toBeGreaterThan(1);
    expect(embeddings.calls).toBe(1);
  });

  it('riassegna i vettori al file giusto', async () => {
    // Punto delicato della fase 3: i vettori tornano in un unico array e
    // vanno ridistribuiti per offset. Se l'offset sbagliasse, ogni chunk
    // finirebbe con il vettore di un altro file — senza errori, solo
    // risposte assurde per sempre.
    const written: Array<{ path: string; contents: string[] }> = [];
    const repository = {
      findExistingHashes: async () => new Set<string>(),
      replaceFileChunks: async (
        _source: string,
        path: string,
        chunks: Array<{ content: string; embedding: number[] }>,
      ) => {
        written.push({ path, contents: chunks.map((chunk) => chunk.content) });
        // Il provider finto genera il vettore dalla lunghezza del testo:
        // se l'accoppiamento è corretto, ogni vettore lo "riconosce".
        for (const chunk of chunks) {
          expect(chunk.embedding[0]).toBe(chunk.content.length / 100);
        }
      },
    } as unknown as RagRepository;

    await ingest(process.cwd(), targets, {
      repository,
      embeddings: fakeProvider(),
    });

    expect(written.length).toBeGreaterThan(1);
  });

  it('salta i file invariati: gli embedding già pagati non si ricalcolano', async () => {
    // Primo giro: registra gli hash prodotti per ogni file.
    const hashes: Record<string, Set<string>> = {};
    const firstRun = {
      findExistingHashes: async () => new Set<string>(),
      replaceFileChunks: async (
        _source: string,
        path: string,
        chunks: Array<{ contentHash: string }>,
      ) => {
        hashes[path] = new Set(chunks.map((chunk) => chunk.contentHash));
      },
    } as unknown as RagRepository;

    await ingest(process.cwd(), targets, {
      repository: firstRun,
      embeddings: fakeProvider(),
    });

    // Secondo giro con gli stessi hash già presenti: nessun embedding nuovo.
    const { repository, saved } = fakeRepository(hashes);
    const embeddings = fakeProvider();

    const result = await ingest(process.cwd(), targets, { repository, embeddings });

    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkipped).toBe(result.filesScanned);
    expect(saved).toEqual([]);
    expect(embeddings.calls).toBe(0);
  });

  it('fallisce chiaramente se il provider restituisce meno vettori dei chunk', async () => {
    const { repository } = fakeRepository();
    const broken = {
      model: 'broken',
      dimensions: 8,
      embed: async () => [[1, 2, 3]], // un vettore solo, qualunque sia l'input
    } as unknown as EmbeddingProvider;

    // Senza questo controllo i vettori verrebbero assegnati ai chunk sbagliati:
    // nessun errore, solo risposte assurde per sempre.
    await expect(
      ingest(process.cwd(), targets, { repository, embeddings: broken }),
    ).rejects.toThrow(/Disallineamento embedding/);
  });
});
