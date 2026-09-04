import { chunkTypeScript } from './typescript.chunker.js';

const SOURCE = 'code';

describe('chunkTypeScript', () => {
  it('crea un chunk per dichiarazione top-level, non per numero di caratteri', () => {
    // Dichiarazioni abbastanza grandi da meritare un vettore ciascuna
    // (sopra la soglia MIN_CHARS del chunker).
    const riempimento = '  // '.padEnd(220, 'x');
    const code = `import { Injectable } from '@nestjs/common';

export function primo(): number {
${riempimento}
  return 1;
}

export interface Secondo {
${riempimento}
  campo: string;
}
`;

    const chunks = chunkTypeScript('src/esempio.ts', code, { source: SOURCE });

    expect(chunks.map((chunk) => chunk.symbol)).toEqual(['primo', 'Secondo']);
  });

  it('accorpa le dichiarazioni minuscole invece di dare a ognuna un vettore', () => {
    // `const DEFAULT_PRICE = PRICES['claude-opus-5'];` da solo è un chunk da
    // 46 caratteri: il suo embedding somiglia a tutte le costanti del progetto
    // e a nessuna domanda. Accorpato al codice che lo usa, invece, ha senso.
    const code = `const PRICES = { opus: 5 };
const DEFAULT_PRICE = PRICES.opus;

export function stima(token: number): number {
  return (token / 1_000_000) * DEFAULT_PRICE;
}
`;

    const chunks = chunkTypeScript('src/prezzi.ts', code, { source: SOURCE });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBe('PRICES…stima');
    // Niente è andato perso: solo, non sta più da solo.
    expect(chunks[0].content).toContain('DEFAULT_PRICE');
    expect(chunks[0].content).toContain('export function stima');
  });

  it('scarta gli import: nessuno cerca "dove importo Injectable"', () => {
    const code = `import { A } from './a.js';
import { B } from './b.js';

export const valore = 42;
`;

    const chunks = chunkTypeScript('src/esempio.ts', code, { source: SOURCE });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBe('valore');
  });

  it('tiene il JSDoc attaccato alla dichiarazione', () => {
    const code = `/**
 * Calcola la distanza coseno fra due vettori.
 */
export function distanza(a: number[], b: number[]): number {
  return 0;
}
`;

    const [chunk] = chunkTypeScript('src/math.ts', code, { source: SOURCE });

    // Il JSDoc è la descrizione in linguaggio naturale della funzione: è la
    // parte che somiglia più alla domanda che farà l'utente. Perderla
    // peggiora il retrieval più di qualunque scelta di modello.
    expect(chunk.content).toContain('Calcola la distanza coseno');
    expect(chunk.content).toContain('export function distanza');
  });

  it('riporta i numeri di riga 1-based, come li mostra un editor', () => {
    const code = ['', '', 'export const x = 1;', ''].join('\n');

    const [chunk] = chunkTypeScript('src/x.ts', code, { source: SOURCE });

    expect(chunk.startLine).toBe(3);
    expect(chunk.endLine).toBe(3);
  });

  it('spezza una classe troppo grande per METODI, qualificando il nome', () => {
    const metodo = (nome: string) => `
  ${nome}(): string {
    // riempimento per superare la soglia di maxChars
    return '${'x'.repeat(200)}';
  }
`;
    const code = `export class Grande {
${metodo('primo')}
${metodo('secondo')}
${metodo('terzo')}
}
`;

    const chunks = chunkTypeScript('src/grande.ts', code, {
      source: SOURCE,
      maxChars: 300,
    });

    // Un metodo è ancora un'unità di significato; tre righe a caso no.
    expect(chunks.map((chunk) => chunk.symbol)).toEqual([
      'Grande.primo',
      'Grande.secondo',
      'Grande.terzo',
    ]);
  });

  it('raggruppa le proprietà brevi invece di farne chunk separati', () => {
    // Forma tipica di un service NestJS: logger + due dipendenze iniettate.
    // Un chunk per proprietà produrrebbe vettori calcolati su 40 caratteri di
    // boilerplate, che somigliano a tutti i logger del progetto e a nessuna
    // domanda vera.
    const code = `export class Servizio {
  private readonly logger = new Logger(Servizio.name);
  private readonly soglia = 20;
  private readonly nome = 'x';

  esegui(): string {
    // corpo lungo per superare la soglia e forzare lo split della classe
    return '${'y'.repeat(400)}';
  }
}
`;

    const chunks = chunkTypeScript('src/servizio.ts', code, {
      source: SOURCE,
      maxChars: 300,
    });

    // Le tre proprietà finiscono in un unico chunk, non tre.
    const proprieta = chunks.find((chunk) => chunk.content.includes('logger'));
    expect(proprieta?.content).toContain('soglia');
    expect(proprieta?.content).toContain('nome');
    expect(chunks.every((chunk) => chunk.content.trim().length > 50)).toBe(true);
  });

  it('non si rompe su un file che non compila', () => {
    // createSourceFile fa solo parsing: nessun type-checking, nessun tsconfig.
    const code = `export function rotta( {
  questo non è TypeScript valido
`;

    expect(() =>
      chunkTypeScript('src/rotta.ts', code, { source: SOURCE }),
    ).not.toThrow();
  });

  it('restituisce array vuoto su file vuoto', () => {
    expect(chunkTypeScript('src/vuoto.ts', '', { source: SOURCE })).toEqual([]);
  });
});
