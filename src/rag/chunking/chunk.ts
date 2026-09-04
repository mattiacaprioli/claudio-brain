/**
 * Un frammento indicizzabile.
 *
 * Il chunking è la decisione che pesa più di tutte sulla qualità di un RAG,
 * più della scelta del modello di embedding. Il motivo è che un embedding è
 * UN vettore per chunk: se il chunk contiene tre argomenti diversi, il vettore
 * finisce a metà strada fra i tre e non somiglia più a nessuno dei tre.
 *
 * Da qui la regola: un chunk = un'unità di significato. Per il codice
 * l'unità naturale è la dichiarazione (funzione, classe, interfaccia), non
 * "500 caratteri".
 */
export interface Chunk {
  /** 'code' | 'docs' | 'hardware' */
  source: string;
  path: string;
  /** 1-based, come le mostra un editor. */
  startLine: number;
  endLine: number;
  /** Nome della funzione/classe/sezione, se identificabile. */
  symbol: string | null;
  content: string;
}

export interface ChunkOptions {
  source: string;
  /**
   * Oltre questa lunghezza un chunk viene spezzato.
   *
   * ~6000 caratteri ≈ 1500 token: sta larghissimo dentro i 32K di
   * voyage-code-4, ma il limite del modello non è il criterio giusto. Il
   * criterio è la DILUIZIONE: più roba metti in un chunk, più il suo vettore
   * diventa generico e meno somiglia alla domanda specifica.
   */
  maxChars?: number;
  /** Righe ripetute fra due pezzi consecutivi, per non tagliare a metà un concetto. */
  overlapLines?: number;
}

export const DEFAULT_MAX_CHARS = 6000;
export const DEFAULT_OVERLAP_LINES = 3;

/**
 * Rete di sicurezza: spezza un blocco troppo lungo per righe, con overlap.
 *
 * È volutamente l'ULTIMA risorsa, non la strategia principale: taglia dove
 * capita, quindi può separare la firma di una funzione dal suo corpo.
 * L'overlap limita il danno ripetendo qualche riga di contesto.
 */
export function splitByLines(
  content: string,
  startLine: number,
  maxChars: number,
  overlapLines: number,
): Array<{ content: string; startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const pieces: Array<{ content: string; startLine: number; endLine: number }> = [];

  let current: string[] = [];
  let currentStart = startLine;

  const flush = () => {
    if (current.length === 0) return;
    pieces.push({
      content: current.join('\n'),
      startLine: currentStart,
      endLine: currentStart + current.length - 1,
    });
  };

  for (const line of lines) {
    const wouldExceed = current.join('\n').length + line.length + 1 > maxChars;
    if (wouldExceed && current.length > 0) {
      flush();
      // Riparte tenendo le ultime `overlapLines` righe del pezzo precedente.
      const overlap = current.slice(-overlapLines);
      currentStart = currentStart + current.length - overlap.length;
      current = [...overlap];
    }
    current.push(line);
  }
  flush();

  return pieces;
}
