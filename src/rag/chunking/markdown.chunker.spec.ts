import { splitByLines } from './chunk.js';
import { chunkMarkdown } from './markdown.chunker.js';

const SOURCE = 'docs';

describe('chunkMarkdown', () => {
  const documento = `# Roadmap

Introduzione al progetto.

## Fase 2

Descrizione della fase.

### Decisioni prese

Abbiamo scelto 1024 dimensioni.

## Fase 3

Altro contenuto.
`;

  it('spezza sulle intestazioni fino al livello 3', () => {
    const chunks = chunkMarkdown('roadmap.md', documento, { source: SOURCE });

    expect(chunks.map((chunk) => chunk.symbol)).toEqual([
      'Roadmap',
      'Fase 2',
      'Decisioni prese',
      'Fase 3',
    ]);
  });

  it('aggiunge il breadcrumb dei genitori: è ciò che rende trovabile la sezione', () => {
    const chunks = chunkMarkdown('roadmap.md', documento, { source: SOURCE });
    const decisioni = chunks.find((chunk) => chunk.symbol === 'Decisioni prese');

    // Il testo della sezione dice "1024 dimensioni" ma non contiene né
    // "Roadmap" né "Fase 2": senza breadcrumb sarebbe invisibile a una
    // ricerca su quei termini, pur essendo la risposta giusta.
    expect(decisioni?.content).toContain('Contesto: Roadmap > Fase 2 > Decisioni prese');
    expect(decisioni?.content).toContain('1024 dimensioni');
  });

  it('azzera le intestazioni più profonde quando si risale di livello', () => {
    const chunks = chunkMarkdown('roadmap.md', documento, { source: SOURCE });
    const fase3 = chunks.find((chunk) => chunk.symbol === 'Fase 3');

    // "Decisioni prese" apparteneva alla Fase 2: non deve comparire nel
    // breadcrumb della Fase 3.
    expect(fase3?.content).not.toContain('Decisioni prese');
  });

  it('non confonde un commento shell dentro un code fence con un titolo', () => {
    const conCodice = `## Setup

\`\`\`bash
nvm use
# per renderlo il default di sistema
nvm alias default 24
\`\`\`

Testo dopo il blocco.
`;

    const chunks = chunkMarkdown('setup.md', conCodice, { source: SOURCE });

    // Una sola sezione: il '#' dentro il fence è un commento bash.
    // Senza il controllo sui fence il documento si spezzerebbe a metà blocco,
    // separando il comando dalla sua spiegazione.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBe('Setup');
    expect(chunks[0].content).toContain('nvm alias default 24');
  });

  it('traccia le righe di ogni sezione', () => {
    const chunks = chunkMarkdown('roadmap.md', documento, { source: SOURCE });
    const fase2 = chunks.find((chunk) => chunk.symbol === 'Fase 2');

    expect(fase2?.startLine).toBe(5);
  });
});

describe('splitByLines', () => {
  it('spezza rispettando il limite e ripete le righe di overlap', () => {
    const content = ['uno', 'due', 'tre', 'quattro', 'cinque'].join('\n');

    const pieces = splitByLines(content, 1, 12, 1);

    expect(pieces.length).toBeGreaterThan(1);
    // L'ultima riga di un pezzo riappare in cima al successivo: serve a non
    // tagliare a metà un concetto al confine fra due chunk.
    const first = pieces[0].content.split('\n');
    const second = pieces[1].content.split('\n');
    expect(second[0]).toBe(first[first.length - 1]);
  });

  it('mantiene coerenti i numeri di riga anche con overlap', () => {
    const content = Array.from({ length: 10 }, (_, i) => `riga ${i + 1}`).join('\n');

    const pieces = splitByLines(content, 100, 30, 2);

    for (const piece of pieces) {
      const lineCount = piece.content.split('\n').length;
      expect(piece.endLine - piece.startLine + 1).toBe(lineCount);
    }
  });
});
