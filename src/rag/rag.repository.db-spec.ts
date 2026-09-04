import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { RagRepository, type ChunkToStore } from './rag.repository.js';

/**
 * Test di integrazione della ricerca ibrida contro il Postgres vero.
 *   npm run db:up && npm run db:migrate && npm run test:db
 *
 * Il punto chiave: **usa vettori sintetici**, non embedding veri. La distanza
 * coseno la calcola Postgres e non gli importa da dove vengono i numeri, così
 * tutto il SQL vettoriale è verificabile senza una API key e senza spendere
 * nulla. Costruiamo vettori "one-hot" (un 1 in una posizione, zeri altrove):
 * due one-hot su posizioni diverse sono ortogonali, uno stesso one-hot è
 * identico — quindi le distanze sono prevedibili a mano.
 */

const DIMENSIONS = 1024;

function oneHot(index: number, weight = 1): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = weight;
  return vector;
}

/** Vettore vicino a `index` ma non identico: simula una somiglianza parziale. */
function mostly(index: number, other: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 0.9;
  vector[other] = 0.1;
  return vector;
}

describe('RagRepository (Postgres vero, vettori sintetici)', () => {
  let repo: RagRepository;
  let db: DatabaseService;

  const SOURCE = 'test-rag';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [RagRepository],
    }).compile();

    repo = moduleRef.get(RagRepository);
    db = moduleRef.get(DatabaseService);
  });

  afterEach(async () => {
    await db.query(`delete from chunks where source like 'test-%'`);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  function chunk(
    overrides: Partial<ChunkToStore> & { content: string; embedding: number[] },
  ): ChunkToStore {
    return {
      source: SOURCE,
      path: 'src/esempio.ts',
      startLine: 1,
      endLine: 10,
      symbol: null,
      contentHash: Math.random().toString(36).slice(2),
      ...overrides,
    };
  }

  it('trova per SIGNIFICATO: il vettore più vicino vince', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/a.ts',
      [
        chunk({ path: 'src/a.ts', content: 'contenuto vicino', embedding: oneHot(5) }),
        chunk({ path: 'src/a.ts', content: 'contenuto lontano', embedding: oneHot(900) }),
      ],
      'test-model',
    );

    const hits = await repo.hybridSearch(mostly(5, 900), 'nessuna parola in comune', {
      limit: 5,
      sources: [SOURCE],
    });

    expect(hits[0].content).toBe('contenuto vicino');
    expect(hits[0].semantic_rank).toBe(1);
  });

  it('trova per STRINGA ESATTA anche se il vettore è ortogonale', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/b.ts',
      [
        chunk({
          path: 'src/b.ts',
          content: 'async findRecentMessagesAfter(conversationId: string) {}',
          // Vettore volutamente lontanissimo dalla query: solo il full-text
          // può trovarlo. È il caso in cui la ricerca vettoriale pura fallisce.
          embedding: oneHot(999),
        }),
        chunk({ path: 'src/b.ts', content: 'altra funzione', embedding: oneHot(1) }),
      ],
      'test-model',
    );

    const hits = await repo.hybridSearch(oneHot(1), 'findRecentMessagesAfter', {
      limit: 5,
      sources: [SOURCE],
    });

    const identificatore = hits.find((hit) => hit.content.includes('findRecent'));
    expect(identificatore).toBeDefined();

    // Trovato per primo dal full-text: la stringa esatta c'è.
    expect(identificatore?.keyword_rank).toBe(1);

    // E nel solo spazio vettoriale era ULTIMO. (Nota: la metà semantica
    // restituisce sempre i primi N candidati a prescindere dalla distanza
    // assoluta, quindi con due sole righe compaiono entrambe: quello che
    // conta è l'ORDINE, non la presenza.)
    expect(identificatore?.semantic_rank).toBe(2);

    // La fusione lo porta primo: è esattamente il valore della ricerca ibrida.
    // Con la sola ricerca vettoriale, cercare il nome di una funzione avrebbe
    // restituito per prima la funzione sbagliata.
    expect(hits[0].content).toContain('findRecentMessagesAfter');
  });

  it('RRF premia chi è trovato da ENTRAMBE le metà', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/c.ts',
      [
        // Trovato da entrambe: vettore vicino E contiene il termine cercato.
        chunk({
          path: 'src/c.ts',
          content: 'funzione hybridSearch che fonde i ranking',
          embedding: mostly(10, 11),
        }),
        // Solo semantico: vettore vicinissimo, ma senza il termine.
        chunk({ path: 'src/c.ts', content: 'testo senza il termine', embedding: oneHot(10) }),
      ],
      'test-model',
    );

    const hits = await repo.hybridSearch(oneHot(10), 'hybridSearch', {
      limit: 5,
      sources: [SOURCE],
    });

    // Il secondo chunk è PIÙ vicino nel solo spazio vettoriale (distanza 0),
    // ma il primo vince perché compare in entrambe le classifiche.
    expect(hits[0].content).toContain('hybridSearch');
    expect(hits[0].semantic_rank).not.toBeNull();
    expect(hits[0].keyword_rank).not.toBeNull();
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('filtra per sorgente: le domande sull hardware non pescano nel codice', async () => {
    await repo.replaceFileChunks(
      'test-code',
      'src/d.ts',
      [chunk({ source: 'test-code', path: 'src/d.ts', content: 'codice', embedding: oneHot(3) })],
      'test-model',
    );
    await repo.replaceFileChunks(
      'test-hardware',
      'hardware/pinout.md',
      [
        chunk({
          source: 'test-hardware',
          path: 'hardware/pinout.md',
          content: 'servo sul pin 18',
          embedding: oneHot(3),
        }),
      ],
      'test-model',
    );

    const hits = await repo.hybridSearch(oneHot(3), 'pin', {
      limit: 5,
      sources: ['test-hardware'],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('test-hardware');
  });

  it('trova col full-text anche con una DOMANDA intera, non solo un termine', async () => {
    // Il bug scoperto provando dal vero: `websearch_to_tsquery` mette i
    // termini in AND, quindi una domanda in linguaggio naturale non trovava
    // MAI nulla e la ricerca ibrida degenerava in ricerca vettoriale pura.
    // Non si vedeva con una query di un solo termine — cioè con tutti i test
    // che avevo scritto.
    await repo.replaceFileChunks(
      SOURCE,
      'src/i.ts',
      [
        chunk({
          path: 'src/i.ts',
          content: 'const cacheUpToIndex = messages.length - 1; // breakpoint esplicito',
          embedding: oneHot(700), // vettore lontano: solo il full-text può trovarlo
        }),
        chunk({ path: 'src/i.ts', content: 'codice non pertinente', embedding: oneHot(50) }),
      ],
      'test-model',
    );

    const hits = await repo.hybridSearch(
      oneHot(50),
      'dove viene applicato il breakpoint di cache quando il RAG è attivo?',
      { limit: 5, sources: [SOURCE] },
    );

    const trovato = hits.find((hit) => hit.content.includes('cacheUpToIndex'));
    expect(trovato).toBeDefined();
    expect(trovato?.keyword_rank).not.toBeNull();
  });

  it('non esplode su una query con caratteri che romperebbero to_tsquery', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/e.ts',
      [chunk({ path: 'src/e.ts', content: 'qualcosa', embedding: oneHot(7) })],
      'test-model',
    );

    // Con `to_tsquery` questo input solleverebbe un errore di sintassi.
    // `websearch_to_tsquery` accetta testo umano qualunque.
    await expect(
      repo.hybridSearch(oneHot(7), 'come si fa a && !! "usare" -questo?', {
        limit: 5,
        sources: [SOURCE],
      }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('replaceFileChunks sostituisce, non accumula (è idempotente)', async () => {
    const primo = [chunk({ content: 'versione 1', embedding: oneHot(20) })];
    const secondo = [
      chunk({ content: 'versione 2a', embedding: oneHot(21) }),
      chunk({ content: 'versione 2b', embedding: oneHot(22) }),
    ];

    await repo.replaceFileChunks(SOURCE, 'src/esempio.ts', primo, 'test-model');
    await repo.replaceFileChunks(SOURCE, 'src/esempio.ts', secondo, 'test-model');

    const rows = await db.query<{ content: string }>(
      `select content from chunks where source = $1 order by id`,
      [SOURCE],
    );
    expect(rows.map((row) => row.content)).toEqual(['versione 2a', 'versione 2b']);
  });

  it('findExistingHashes restituisce gli hash indicizzati (base dell ingestion incrementale)', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/f.ts',
      [
        chunk({ path: 'src/f.ts', content: 'a', embedding: oneHot(30), contentHash: 'hash-a' }),
        chunk({ path: 'src/f.ts', content: 'b', embedding: oneHot(31), contentHash: 'hash-b' }),
      ],
      'test-model',
    );

    const hashes = await repo.findExistingHashes(SOURCE, 'src/f.ts');

    expect(hashes).toEqual(new Set(['hash-a', 'hash-b']));
  });

  it('rifiuta un vettore con la dimensione sbagliata', async () => {
    // La dimensione è fissa per colonna: è il vincolo che rende "cambiare
    // modello di embedding" una migration e non un UPDATE.
    await expect(
      repo.replaceFileChunks(
        SOURCE,
        'src/g.ts',
        [chunk({ path: 'src/g.ts', content: 'x', embedding: [1, 2, 3] })],
        'test-model',
      ),
    ).rejects.toThrow(/expected 1024 dimensions/i);
  });

  it('l indice HNSW è utilizzabile per la distanza coseno', async () => {
    await repo.replaceFileChunks(
      SOURCE,
      'src/h.ts',
      Array.from({ length: 50 }, (_, index) =>
        chunk({ path: 'src/h.ts', content: `chunk ${index}`, embedding: oneHot(index) }),
      ),
      'test-model',
    );

    // Su 50 righe il planner sceglie comunque un Seq Scan, ed è la scelta
    // giusta: leggere una tabella minuscola costa meno che passare per
    // l'indice. Per verificare che l'indice sia UTILIZZABILE bisogna quindi
    // togliere al planner l'alternativa.
    //
    // `set local` vive solo dentro la transazione, quindi non altera la
    // sessione né le altre query. E se l'opclass fosse sbagliata (per esempio
    // vector_l2_ops mentre la query usa <=>), l'indice resterebbe
    // inutilizzabile anche così e qui ricomparirebbe un Seq Scan.
    const text = await db.withTransaction(async (query) => {
      await query('set local enable_seqscan = off');
      const plan = await query<{ 'QUERY PLAN': string }>(
        `explain select id from chunks order by embedding <=> $1::vector limit 5`,
        [`[${oneHot(5).join(',')}]`],
      );
      return plan.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(text).toContain('chunks_embedding_idx');
  });
});
