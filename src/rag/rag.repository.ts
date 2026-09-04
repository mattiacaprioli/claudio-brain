import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { Chunk } from './chunking/chunk.js';
import { toVectorLiteral } from './embedding.provider.js';
import { buildKeywordQuery } from './keyword-query.js';

export interface SearchHit {
  id: string;
  source: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  symbol: string | null;
  content: string;
  /** Punteggio fuso dei due ranking (più alto = più rilevante). */
  score: number;
  /** Posizione nel ranking vettoriale, null se non trovato da quella metà. */
  semantic_rank: number | null;
  /** Posizione nel ranking full-text, null se non trovato da quella metà. */
  keyword_rank: number | null;
}

export interface ChunkToStore extends Chunk {
  contentHash: string;
  embedding: number[];
}

/**
 * Costante della Reciprocal Rank Fusion.
 *
 * RRF fonde due classifiche assegnando a ciascun risultato 1/(k + posizione)
 * e sommando. Il valore 60 viene dal paper originale ed è il default di fatto.
 *
 * Perché fondere le POSIZIONI e non i punteggi: la distanza coseno sta fra 0 e
 * 2, `ts_rank_cd` restituisce numeri senza scala fissa. Sommarli direttamente
 * significa inventarsi un peso fra due unità di misura incompatibili; sommare
 * i reciproci delle posizioni no.
 *
 * Effetto pratico di k=60: essere primo in una sola classifica vale meno che
 * essere terzo in entrambe — ed è esattamente il comportamento che si vuole,
 * perché un risultato trovato da entrambe le metà è quasi sempre quello giusto.
 */
const RRF_K = 60;

@Injectable()
export class RagRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * RICERCA IBRIDA.
   *
   * Due classifiche indipendenti, poi fuse:
   *
   * - `semantic`: distanza coseno (`<=>`) sull'embedding. Trova per SIGNIFICATO
   *   ("come funziona la memoria" trova il riassuntore anche se la parola
   *   "memoria" non c'è).
   * - `keyword`: full-text su `content_tsv`. Trova per STRINGA ESATTA
   *   (`findRecentMessagesAfter`), che è proprio ciò su cui gli embedding
   *   sbagliano — un identificatore raro somiglia semanticamente a tutti i
   *   suoi fratelli.
   *
   * `websearch_to_tsquery` e non `to_tsquery`: accetta input umano qualunque
   * (virgolette, trattini, parole spaiate) senza sollevare errori di sintassi.
   * Con `to_tsquery`, una domanda scritta normalmente fa fallire la query.
   *
   * ATTENZIONE al testo che gli si passa: `websearch_to_tsquery` mette in AND
   * i termini, quindi una domanda intera non trova mai nulla. Il testo va
   * preparato da `buildKeywordQuery`, che li mette in OR — vedi il commento
   * lì, è il bug più subdolo incontrato in questa fase.
   */
  async hybridSearch(
    queryEmbedding: number[],
    queryText: string,
    options: { limit: number; candidates?: number; sources?: string[] },
  ): Promise<SearchHit[]> {
    const candidates = options.candidates ?? Math.max(options.limit * 5, 20);
    const keywordQuery = buildKeywordQuery(queryText);

    return this.db.query<SearchHit>(
      `with semantic as (
         select id, row_number() over (order by embedding <=> $1::vector) as rank
         from chunks
         where ($4::text[] is null or source = any($4::text[]))
         order by embedding <=> $1::vector
         limit $3
       ),
       keyword as (
         select c.id,
                row_number() over (
                  order by ts_rank_cd(c.content_tsv, q.query) desc, c.id
                ) as rank
         from chunks c, websearch_to_tsquery('simple'::regconfig, $2) as q(query)
         where c.content_tsv @@ q.query
           and ($4::text[] is null or c.source = any($4::text[]))
         order by ts_rank_cd(c.content_tsv, q.query) desc, c.id
         limit $3
       )
       select c.id, c.source, c.path, c.start_line, c.end_line, c.symbol, c.content,
              -- I cast NON sono cosmetici: row_number() e' bigint e la somma
              -- di 1.0/... e' numeric, e il driver pg consegna entrambi come
              -- STRINGHE (un bigint non entra in un Number JS in sicurezza).
              -- Senza i cast, score arriverebbe come "0.032" e un confronto
              -- score > altro confronterebbe stringhe, in silenzio.
              (coalesce(1.0 / ($6 + s.rank), 0) + coalesce(1.0 / ($6 + k.rank), 0))
                ::float8 as score,
              s.rank::int as semantic_rank,
              k.rank::int as keyword_rank
       from chunks c
         left join semantic s on s.id = c.id
         left join keyword  k on k.id = c.id
       where s.id is not null or k.id is not null
       order by score desc, c.id
       limit $5`,
      [
        toVectorLiteral(queryEmbedding),
        keywordQuery,
        candidates,
        options.sources && options.sources.length > 0 ? options.sources : null,
        options.limit,
        RRF_K,
      ],
    );
  }

  /**
   * Sostituisce i chunk di un file, in TRANSAZIONE.
   *
   * Delete + insert e non un merge riga per riga: se un file viene modificato,
   * i suoi confini di chunk cambiano tutti (una riga aggiunta in cima sposta
   * ogni `start_line`), quindi non c'è nulla da aggiornare selettivamente.
   *
   * La transazione serve perché fra il delete e l'insert il file resterebbe
   * senza chunk: una ricerca in quel momento non troverebbe nulla, e un errore
   * a metà lascerebbe il file scomparso dall'indice.
   */
  async replaceFileChunks(
    source: string,
    path: string,
    chunks: ChunkToStore[],
    embeddingModel: string,
  ): Promise<void> {
    await this.db.withTransaction(async (query) => {
      await query(`delete from chunks where source = $1 and path = $2`, [
        source,
        path,
      ]);

      for (const chunk of chunks) {
        await query(
          `insert into chunks
             (source, path, start_line, end_line, symbol,
              content, content_hash, embedding_model, embedding)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
          [
            chunk.source,
            chunk.path,
            chunk.startLine,
            chunk.endLine,
            chunk.symbol,
            chunk.content,
            chunk.contentHash,
            embeddingModel,
            toVectorLiteral(chunk.embedding),
          ],
        );
      }
    });
  }

  /** Hash dei chunk già indicizzati per un file: base dell'ingestion incrementale. */
  async findExistingHashes(source: string, path: string): Promise<Set<string>> {
    const rows = await this.db.query<{ content_hash: string }>(
      `select content_hash from chunks where source = $1 and path = $2`,
      [source, path],
    );
    return new Set(rows.map((row) => row.content_hash));
  }

  async deleteFile(source: string, path: string): Promise<void> {
    await this.db.query(`delete from chunks where source = $1 and path = $2`, [
      source,
      path,
    ]);
  }

  async listIndexedPaths(source: string): Promise<string[]> {
    const rows = await this.db.query<{ path: string }>(
      `select distinct path from chunks where source = $1`,
      [source],
    );
    return rows.map((row) => row.path);
  }

  async stats(): Promise<
    Array<{ source: string; chunks: number; files: number; model: string }>
  > {
    const rows = await this.db.query<{
      source: string;
      chunks: string;
      files: string;
      model: string;
    }>(
      `select source,
              count(*)                       as chunks,
              count(distinct path)           as files,
              min(embedding_model)           as model
       from chunks
       group by source
       order by source`,
    );
    return rows.map((row) => ({
      source: row.source,
      chunks: Number(row.chunks),
      files: Number(row.files),
      model: row.model,
    }));
  }
}
