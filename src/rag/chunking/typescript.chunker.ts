import ts from 'typescript';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP_LINES,
  splitByLines,
  type Chunk,
  type ChunkOptions,
} from './chunk.js';

/**
 * Sotto questa soglia una dichiarazione non merita un vettore per sé.
 *
 * Il caso tipico è `const DEFAULT_PRICE = PRICES['claude-opus-5'];` o
 * `private readonly logger = new Logger(...)`: quaranta caratteri di
 * boilerplate il cui embedding somiglia a tutti i suoi omologhi nel progetto
 * e a nessuna domanda vera. Sono chunk che non vengono mai recuperati
 * utilmente ma occupano posti nella classifica dei candidati.
 *
 * Le dichiarazioni più corte di così vengono ACCORPATE alla successiva, non
 * scartate: il contenuto resta indicizzato, solo non da solo.
 */
const MIN_CHARS = 200;

/**
 * Chunker per TypeScript guidato dall'AST.
 *
 * L'alternativa comune — spezzare ogni 500 caratteri con 50 di overlap — su
 * codice fa danni precisi: taglia funzioni a metà, separa una firma dal suo
 * corpo, e produce chunk che iniziano con `}` chiuse senza contesto. Il
 * risultato è un indice che "somiglia" a tutto e non risponde a niente.
 *
 * Qui usiamo il parser del compilatore TypeScript, che è già una dipendenza del
 * progetto: ogni dichiarazione top-level (funzione, classe, interfaccia, type,
 * enum, costante) diventa un chunk, con il suo JSDoc attaccato.
 *
 * Nota sull'uso del compilatore: `createSourceFile` fa solo il PARSING, non il
 * type-checking. Non serve un `tsconfig`, non risolve import, non richiede che
 * il progetto compili — è veloce e funziona anche su file rotti.
 */
export function chunkTypeScript(
  path: string,
  text: string,
  options: ChunkOptions,
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES;

  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    // setParentNodes: true — serve perché i nodi sappiano risalire al padre.
    true,
  );

  const chunks: Chunk[] = [];
  const topLevel: ExtractedDeclaration[] = [];

  const flushTopLevel = () => {
    chunks.push(
      ...packDeclarations(topLevel, {
        source: options.source,
        path,
        text,
        sourceFile,
        maxChars,
        overlapLines,
      }),
    );
    topLevel.length = 0;
  };

  for (const statement of sourceFile.statements) {
    // Gli import non portano informazione recuperabile: nessuno chiede
    // "dove importo Injectable". Indicizzarli aggiunge solo rumore.
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      continue;
    }

    const declaration = extractDeclaration(statement, sourceFile, text);
    if (declaration.content.trim().length === 0) continue;

    // Una classe troppo grande viene spezzata per MEMBRI, non per righe:
    // un metodo è ancora un'unità di significato, tre righe a caso no.
    // Le dichiarazioni top-level accumulate finora vanno emesse prima, per
    // non far scavalcare l'ordine del file.
    if (declaration.content.length > maxChars && ts.isClassDeclaration(statement)) {
      flushTopLevel();
      chunks.push(
        ...chunkClassMembers(statement, sourceFile, text, {
          source: options.source,
          path,
          maxChars,
          overlapLines,
        }),
      );
      continue;
    }

    topLevel.push(declaration);
  }
  flushTopLevel();

  return chunks;
}

interface PackContext {
  source: string;
  path: string;
  text: string;
  sourceFile: ts.SourceFile;
  maxChars: number;
  overlapLines: number;
  /** Prefisso per i simboli, es. il nome della classe. */
  qualifier?: string;
}

/**
 * Politica unica di impacchettamento, usata sia per il top-level sia per i
 * membri di una classe.
 *
 * Due regole, che tirano in direzioni opposte e vanno bilanciate:
 *
 * - **non troppo piccolo** (`MIN_CHARS`): un chunk minuscolo produce un
 *   vettore generico che non risponde a nulla;
 * - **non troppo grande** (`maxChars`): un chunk con tre argomenti dentro
 *   produce un vettore a metà strada fra i tre, che non somiglia a nessuno.
 *
 * Quindi: si accumulano dichiarazioni contigue finché il gruppo non ha
 * raggiunto una taglia sensata, e si chiude appena aggiungere la prossima
 * sfonderebbe il tetto.
 */
function packDeclarations(
  declarations: ExtractedDeclaration[],
  context: PackContext,
): Chunk[] {
  const chunks: Chunk[] = [];
  let group: ExtractedDeclaration[] = [];
  let groupLength = 0;

  const flush = () => {
    if (group.length === 0) return;

    const first = group[0];
    const last = group[group.length - 1];

    // Testo CONTINUO dal primo all'ultimo membro del gruppo: così restano
    // intatte spaziature e commenti fra le dichiarazioni.
    const content = context.text.slice(first.start, last.end);
    const symbol = buildSymbol(group, context.qualifier);

    if (content.length > context.maxChars) {
      for (const piece of splitByLines(
        content,
        first.startLine,
        context.maxChars,
        context.overlapLines,
      )) {
        chunks.push({
          source: context.source,
          path: context.path,
          startLine: piece.startLine,
          endLine: piece.endLine,
          symbol,
          content: piece.content,
        });
      }
    } else {
      chunks.push({
        source: context.source,
        path: context.path,
        startLine: first.startLine,
        endLine: last.endLine,
        symbol,
        content,
      });
    }

    group = [];
    groupLength = 0;
  };

  for (const declaration of declarations) {
    const wouldExceed =
      groupLength > 0 && groupLength + declaration.content.length > context.maxChars;
    // Il gruppo si chiude solo se ha già una taglia utile: sotto MIN_CHARS
    // continuiamo ad accumulare anche se ciò significa superare un po' il tetto.
    if (wouldExceed && groupLength >= MIN_CHARS) {
      flush();
    }
    group.push(declaration);
    groupLength += declaration.content.length;

    if (groupLength >= MIN_CHARS && declaration.content.length >= MIN_CHARS) {
      flush();
    }
  }
  flush();

  // CODA ORFANA. Caso tipico: `await main();` in fondo a uno script, che
  // arriva dopo una funzione grande e quindi non ha nulla con cui
  // raggrupparsi guardando solo avanti. Resterebbe un vettore da tredici
  // caratteri: lo attacchiamo al chunk precedente, che è anche il suo
  // contesto naturale (la funzione che invoca).
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (last.content.length < MIN_CHARS) {
      chunks.pop();
      const previous = chunks[chunks.length - 1];
      previous.content = `${previous.content}\n\n${last.content}`;
      previous.endLine = last.endLine;
    }
  }

  return chunks;
}

function buildSymbol(
  group: ExtractedDeclaration[],
  qualifier?: string,
): string | null {
  const names = group
    .map((item) => item.symbol)
    .filter((name): name is string => Boolean(name));

  // Il simbolo resta qualificato dal nome della classe: senza di esso un
  // metodo `search` non si distingue dagli altri dieci del progetto.
  const prefix = qualifier ? `${qualifier}.` : '';

  if (names.length === 0) return qualifier ?? null;
  if (names.length === 1) return `${prefix}${names[0]}`;
  return `${prefix}${names[0]}…${names[names.length - 1]}`;
}

function chunkClassMembers(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  text: string,
  context: Omit<PackContext, 'text' | 'sourceFile' | 'qualifier'>,
): Chunk[] {
  const declarations = node.members
    .map((member) => extractDeclaration(member, sourceFile, text))
    .filter((declaration) => declaration.content.trim().length > 0);

  return packDeclarations(declarations, {
    ...context,
    text,
    sourceFile,
    qualifier: node.name?.text ?? 'anonymous',
  });
}

interface ExtractedDeclaration {
  content: string;
  startLine: number;
  endLine: number;
  /** Posizioni nel file: servono a ricostruire il testo continuo di un gruppo. */
  start: number;
  end: number;
  symbol: string | null;
}

function extractDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  text: string,
): ExtractedDeclaration {
  // Il JSDoc sopra una funzione è spesso la sua MIGLIORE descrizione in
  // linguaggio naturale — cioè la cosa che somiglia più alla domanda che farà
  // l'utente. Buttarlo via è il modo più rapido di peggiorare il retrieval.
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const start = comments.length > 0 ? comments[0].pos : node.getStart(sourceFile);
  const end = node.getEnd();

  return {
    content: text.slice(start, end),
    startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
    start,
    end,
    symbol: symbolName(node),
  };
}

function symbolName(node: ts.Node): string | null {
  if (ts.isVariableStatement(node)) {
    const [first] = node.declarationList.declarations;
    return first && ts.isIdentifier(first.name) ? first.name.text : null;
  }

  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }

  // Copre function, class, interface, type alias, enum, metodi e proprietà.
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) {
    return named.name.text;
  }

  return null;
}
