import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding.provider.js';
import { RagRepository, type SearchHit } from './rag.repository.js';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly topK: number;

  /**
   * Il RAG è dietro un flag perché richiede un SECONDO provider (Voyage) oltre
   * ad Anthropic. Senza il flag, chi ha solo la key di Anthropic non potrebbe
   * più usare la chat — e la Fase 1 deve restare utilizzabile da sola.
   */
  readonly enabled: boolean;

  constructor(
    private readonly repository: RagRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('RAG_ENABLED') === 'true';
    this.topK = Number(config.get<string>('RAG_TOP_K') ?? 4);
  }

  /** Cerca i frammenti rilevanti per una domanda. Array vuoto se il RAG è spento. */
  async search(query: string, sources?: string[]): Promise<SearchHit[]> {
    if (!this.enabled) return [];

    // input_type: 'query' e non 'document'. Vedi il commento
    // nell'interfaccia EmbeddingProvider: sbagliarlo degrada il retrieval
    // senza dare alcun segnale.
    const [queryEmbedding] = await this.embeddings.embed([query], 'query');

    const hits = await this.repository.hybridSearch(queryEmbedding, query, {
      limit: this.topK,
      sources,
    });

    this.logger.debug(
      `"${query.slice(0, 40)}" → ${hits.length} frammenti ` +
        `(${hits.filter((h) => h.semantic_rank !== null && h.keyword_rank !== null).length} trovati da entrambe le metà)`,
    );
    return hits;
  }

  /**
   * Formatta i frammenti per il prompt.
   *
   * Tre scelte deliberate:
   *
   * 1. **La provenienza è dentro il testo** (`path:righe`), non solo nei
   *    metadati: così il modello può citare il file nella risposta, ed è
   *    verificabile. Un RAG che non dice da dove viene la risposta non è
   *    controllabile.
   * 2. **Tag XML** attorno al contesto: delimitano dove finiscono i dati e
   *    dove ricomincia la domanda, e riducono il rischio che il contenuto di
   *    un file venga letto come un'istruzione.
   * 3. **Istruzione esplicita di ignorare il contesto se non pertinente.**
   *    Senza questa riga, il modello tende a usare per forza ciò che gli hai
   *    messo davanti, e inventa collegamenti fra la domanda e il frammento
   *    sbagliato. È il difetto più comune dei RAG fatti in casa.
   */
  buildContext(hits: SearchHit[]): string {
    if (hits.length === 0) return '';

    const fragments = hits
      .map((hit) => {
        const location =
          hit.start_line && hit.end_line
            ? `${hit.path}:${hit.start_line}-${hit.end_line}`
            : hit.path;
        const symbol = hit.symbol ? ` (${hit.symbol})` : '';
        return `<frammento origine="${location}"${symbol ? ` simbolo="${hit.symbol}"` : ''}>\n${hit.content}\n</frammento>`;
      })
      .join('\n\n');

    return `<contesto_recuperato>
Frammenti estratti dal codice e dalla documentazione locale, forse utili alla domanda.
Se non sono pertinenti, ignorali e dillo: non forzare un collegamento.
Quando usi un frammento, cita l'origine nel formato percorso/file.ts:riga.

${fragments}
</contesto_recuperato>`;
  }

  async stats() {
    return this.repository.stats();
  }
}
