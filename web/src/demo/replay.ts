import type { ChatStreamEvent, Meta } from '../types';
import registrazioni from './recordings.json';

/**
 * La modalità demo: gli stessi eventi, letti da un file invece che dalla rete.
 *
 * Serve alla vetrina del portfolio, che non può avere un backend — i tool
 * eseguono comandi sulla macchina, in cloud non avrebbero nulla da ispezionare,
 * e un link pubblico brucerebbe la API key a chiunque passi.
 *
 * L'idea che la rende una lezione e non un ripiego: **se gli eventi sono un
 * protocollo, il trasporto è intercambiabile**. La UI non sa — e non deve
 * sapere — se i frame arrivano da `fetch` o da un JSON. Per questo `replayChat`
 * ha la stessa identica firma di `streamChat`: la scelta si fa una volta sola,
 * in `transport.ts`, e nessun componente contiene un `if (demo)`.
 *
 * Gli eventi sono REALI: catturati da conversazioni vere con
 * `npm run demo:record`, coi tempi realmente misurati. Non sono risposte
 * scritte a mano che imitano un modello.
 */

interface EventoRegistrato {
  afterMs: number;
  event: ChatStreamEvent;
}

interface Registrazione {
  question: string;
  events: EventoRegistrato[];
}

const DATI = registrazioni as unknown as {
  recordedAt: string;
  meta: Meta;
  conversations: Registrazione[];
};

/**
 * Le pause vere possono arrivare a quindici secondi: è il tempo in cui il
 * modello ragiona prima del primo token, ed è onesto — ma davanti a una
 * vetrina, quindici secondi di faccia che pensa sono una pagina che sembra
 * rotta. Le pause si accorciano, il RITMO resta quello vero: tutto ciò che
 * dura meno del tetto passa invariato, e l'accorciamento è dichiarato in
 * pagina invece di essere nascosto.
 */
const PAUSA_MASSIMA_MS = 1800;

/** Un errore che NON è un guasto: la domanda semplicemente non è registrata. */
export class RegistrazioneMancante extends Error {
  constructor() {
    super('Domanda non registrata');
    this.name = 'RegistrazioneMancante';
  }
}

/**
 * Funzioni e non costanti, e la ragione è il bundle del kiosk.
 *
 * Un `export const x = DATI.conversations.map(...)` esegue quel `.map()` al
 * caricamento del modulo: per Rollup è un effetto collaterale che non può
 * dimostrare innocuo, quindi tiene il modulo — e con lui le registrazioni —
 * anche quando la modalità demo è spenta e nessuno le userà mai. Dentro una
 * funzione, il calcolo avviene solo se qualcuno chiama, e il ramo morto se ne
 * va davvero: bundle del kiosk da 380 a 370 KB, con zero tracce delle
 * registrazioni (verificato cercandone il contenuto nel file prodotto).
 */
export function registratoIl(): string {
  return DATI.recordedAt;
}

export function domandeRegistrate(): string[] {
  return DATI.conversations.map((c) => c.question);
}

/**
 * Confronto tollerante: chi ricopia una domanda a mano sbaglia una maiuscola o
 * un punto interrogativo, e sarebbe assurdo rispondergli "non registrata".
 */
function normalizza(testo: string): string {
  return testo
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function attendi(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((risolvi, rifiuta) => {
    const timer = setTimeout(risolvi, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        rifiuta(new DOMException('Riproduzione interrotta', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** L'inventario, registrato insieme alle conversazioni: `/chat/meta` qui non esiste. */
export function replayMeta(): Promise<Meta> {
  return Promise.resolve(DATI.meta);
}

/**
 * Stessa firma di `streamChat`. L'unica differenza osservabile è che una
 * domanda non registrata solleva `RegistrazioneMancante` invece di chiamare la
 * rete — e la UI la tratta come una nota, non come un errore.
 */
export async function replayChat(
  body: { message: string; conversationId?: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cercata = normalizza(body.message);
  const registrazione = DATI.conversations.find(
    (c) => normalizza(c.question) === cercata,
  );

  if (!registrazione) throw new RegistrazioneMancante();

  for (const { afterMs, event } of registrazione.events) {
    await attendi(Math.min(afterMs, PAUSA_MASSIMA_MS), signal);
    // Dopo l'attesa, non prima: se nel frattempo l'utente ha premuto Ferma,
    // l'evento non deve comparire comunque.
    if (signal?.aborted) return;
    onEvent(event);
  }
}
