/**
 * Cosa serve davvero sapere di un modello di embedding per usarlo.
 *
 * Tenere questa interfaccia sottile è la scelta che rende la decisione
 * "Voyage o OpenAI" reversibile in un file — e con un corpus da 25.000 token
 * la re-ingestion costa tre millesimi di dollaro, quindi cambiare idea è
 * un comando, non un rifacimento.
 */
export interface EmbeddingProvider {
  /** Identificatore da salvare accanto al vettore, per sapere chi lo ha generato. */
  readonly model: string;
  /** Deve combaciare con `vector(N)` della migration, o Postgres rifiuta l'insert. */
  readonly dimensions: number;

  /**
   * `inputType` non è un dettaglio: i modelli di retrieval sono addestrati in
   * modo ASIMMETRICO. Il provider premette istruzioni diverse a un documento
   * da indicizzare e a una domanda da cercare, così i due vettori si
   * avvicinano invece di somigliarsi solo per genere letterario.
   * Usare 'document' per entrambi peggiora il retrieval in modo silenzioso.
   */
  embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]>;
}

/** Token di iniezione: in Nest un'interfaccia TypeScript non esiste a runtime. */
export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';

/**
 * Stima dei token di un testo, per rispettare i limiti prima di inviare.
 *
 * Il divisore è **3 e non 4**. La regola "4 caratteri = 1 token" vale per la
 * prosa inglese; il **codice tokenizza peggio** — simboli, indentazione,
 * `camelCase` e underscore si spezzano in più token — quindi con 4 si
 * SOTTOSTIMA, e sottostimare qui significa costruire richieste che sfondano il
 * limite del provider e vengono rifiutate per sempre, qualunque retry.
 *
 * Meglio sovrastimare: il costo è qualche richiesta in più, non un errore.
 * Il conteggio esatto lo fa il server e torna in `usage.total_tokens`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * pgvector non accetta un array JS: il driver `pg` lo serializzerebbe come
 * array Postgres (`{1,2,3}`), mentre il tipo `vector` vuole `[1,2,3]`.
 * È un errore che si manifesta come "malformed vector literal", non come
 * problema di tipi.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
