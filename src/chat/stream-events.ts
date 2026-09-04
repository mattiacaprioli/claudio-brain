/**
 * Il protocollo di streaming fra backend e frontend.
 *
 * È un'unione discriminata su `type`: il client fa uno switch e sa
 * esattamente cosa gli è arrivato. Definirlo qui, in un file condiviso, evita
 * il problema classico dei protocolli inventati a mano — backend e frontend
 * che divergono su un nome di campo e si accorgono a runtime.
 *
 * Perché un protocollo nostro invece di quello di una libreria: gli eventi che
 * rendono utile questa interfaccia sono `tool_start` e `tool_end`, cioè il
 * fatto che l'utente veda "sto leggendo il git diff…" mentre accade. Sono
 * eventi del NOSTRO loop dell'agente: nessuna libreria li conosce.
 */
export type ChatStreamEvent =
  /** Primo evento: l'id serve al client per i turni successivi. */
  | { type: 'conversation'; conversationId: string }
  /** I frammenti recuperati dal RAG, prima che il modello inizi a parlare. */
  | {
      type: 'retrieval';
      fragments: Array<{
        path: string;
        lines: string | null;
        symbol: string | null;
        foundBy: string;
      }>;
    }
  /** Un giro del loop dell'agente (1 = primo). */
  | { type: 'iteration'; index: number }
  /** Un pezzo di testo generato. È l'evento più frequente. */
  | { type: 'text'; text: string }
  /** Il modello ha chiesto uno strumento: da qui l'indicatore "in corso". */
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  /** Lo strumento ha finito, con esito e durata. */
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      durationMs: number;
      preview: string;
    }
  /** Fine del turno, con la contabilità. */
  | {
      type: 'done';
      usage: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        iterations: number;
      };
    }
  /** Errore: arriva come evento e non come HTTP 500, perché lo stream è già aperto. */
  | { type: 'error'; message: string };

/** Firma della funzione che pubblica un evento. */
export type EmitEvent = (event: ChatStreamEvent) => void;

/**
 * Serializza un evento nel formato Server-Sent Events.
 *
 * Il formato è banale ma implacabile: `data: <payload>\n\n`. La riga vuota
 * finale è il delimitatore del messaggio — dimenticarla significa che il
 * client resta in attesa senza errori, e sembra che il server non risponda.
 */
export function toSseFrame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
