import {
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP_LINES,
  splitByLines,
  type Chunk,
  type ChunkOptions,
} from './chunk.js';

const HEADING = /^(#{1,6})\s+(.*)$/;
/** Apertura/chiusura di un blocco di codice: ``` oppure ~~~ */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Chunker per Markdown guidato dalle intestazioni.
 *
 * Per un documento, l'unità di significato è la sezione: le intestazioni sono
 * già una struttura scritta da un umano, e ignorarla per spezzare a caratteri
 * fissi è buttare via informazione gratis.
 *
 * Il pezzo che fa la differenza nel retrieval è il **breadcrumb**: ogni chunk
 * si porta dietro le intestazioni dei suoi genitori.
 *
 *     # Roadmap > ## Fase 2 > ### Decisioni prese
 *
 * Senza di esso, una sezione che dice "abbiamo scelto 1024 dimensioni" non
 * contiene da nessuna parte la parola "embedding" o "Fase 2": è invisibile a
 * una ricerca su quei termini, anche se è esattamente la risposta giusta.
 */
export function chunkMarkdown(
  path: string,
  text: string,
  options: ChunkOptions & { splitLevel?: number },
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
  // Spezziamo su h1/h2/h3: sotto quel livello le sezioni sono troppo piccole
  // e frammentare di più peggiora, non migliora.
  const splitLevel = options.splitLevel ?? 3;

  const lines = text.split('\n');
  const chunks: Chunk[] = [];

  /** Intestazioni correnti per livello (1-6), per costruire il breadcrumb. */
  const headings: Array<string | null> = new Array(7).fill(null);
  let buffer: string[] = [];
  let bufferStart = 1;
  let bufferSymbol: string | null = null;
  let bufferBreadcrumb = '';

  const flush = (endLine: number) => {
    const body = buffer.join('\n').trim();
    if (body.length === 0) return;

    const content = bufferBreadcrumb
      ? `${bufferBreadcrumb}\n\n${buffer.join('\n')}`
      : buffer.join('\n');

    if (content.length > maxChars) {
      for (const piece of splitByLines(content, bufferStart, maxChars, overlapLines)) {
        chunks.push({
          source: options.source,
          path,
          startLine: piece.startLine,
          endLine: piece.endLine,
          symbol: bufferSymbol,
          content: piece.content,
        });
      }
      return;
    }

    chunks.push({
      source: options.source,
      path,
      startLine: bufferStart,
      endLine: endLine,
      symbol: bufferSymbol,
      content,
    });
  };

  let insideFence = false;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    // I code fence vanno tracciati PRIMA di cercare intestazioni: dentro un
    // blocco di codice una riga come `# installa le dipendenze` è un commento
    // shell, non un titolo. Senza questo controllo un documento con esempi
    // bash viene spezzato nei posti sbagliati — e il chunk risultante contiene
    // mezzo blocco di codice senza la sua spiegazione.
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      buffer.push(line);
      return;
    }

    const match = insideFence ? null : HEADING.exec(line);

    if (match) {
      const level = match[1].length;
      const title = match[2].trim();

      if (level <= splitLevel) {
        flush(lineNumber - 1);
        // Le intestazioni più profonde di questa non valgono più.
        for (let deeper = level; deeper <= 6; deeper += 1) {
          headings[deeper] = null;
        }
        headings[level] = title;
        bufferBreadcrumb = buildBreadcrumb(headings, level);
        bufferSymbol = title;
        bufferStart = lineNumber;
        buffer = [line];
        return;
      }

      headings[level] = title;
    }

    buffer.push(line);
  });

  flush(lines.length);
  return chunks;
}

function buildBreadcrumb(headings: Array<string | null>, upToLevel: number): string {
  const trail: string[] = [];
  for (let level = 1; level <= upToLevel; level += 1) {
    const heading = headings[level];
    if (heading) trail.push(heading);
  }
  return trail.length > 1 ? `Contesto: ${trail.join(' > ')}` : '';
}
