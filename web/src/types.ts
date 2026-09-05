/**
 * Il protocollo di streaming, lato client.
 *
 * ATTENZIONE: la fonte di verità è `src/chat/stream-events.ts` nel backend.
 * Qui è duplicato di proposito — il frontend ha un suo tsconfig e un suo
 * bundler, e importare attraverso il confine dei due progetti costringerebbe
 * a un setup di build condiviso che a questa scala non si ripaga.
 *
 * Il prezzo è che i due file possono divergere. Se succede, si vede subito:
 * lo switch in `App.tsx` non gestisce un tipo che arriva.
 */
export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'retrieval'; fragments: Fragment[] }
  | { type: 'iteration'; index: number }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      durationMs: number;
      preview: string;
    }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; message: string };

export interface Fragment {
  path: string;
  lines: string | null;
  symbol: string | null;
  foundBy: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  iterations: number;
}

/** Uno strumento in esecuzione o concluso, come lo mostra la UI. */
export interface ToolActivity {
  id: string;
  name: string;
  input: unknown;
  /** undefined = ancora in corso. */
  durationMs?: number;
  isError?: boolean;
  preview?: string;
}

export interface Meta {
  tools: Array<{ name: string; description: string }>;
  ragEnabled: boolean;
  index: Array<{ source: string; chunks: number; files: number; model: string }>;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  fragments?: Fragment[];
  tools?: ToolActivity[];
  usage?: Usage;
  error?: string;
  /**
   * Un avviso della UI, non del modello: in modalità demo dice che la domanda
   * non è fra quelle registrate. Sta separato da `error` perché non è un
   * guasto, e colorarlo come tale sarebbe una diagnosi sbagliata.
   */
  note?: string;
  /** true mentre il testo sta ancora arrivando. */
  streaming?: boolean;
}
