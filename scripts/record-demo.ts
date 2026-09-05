/**
 * Registra conversazioni VERE e le salva per la demo del portfolio.
 *
 * Perché esiste. La vetrina su Vercel non può avere un backend: i tool
 * eseguono comandi sulla macchina (git, docker, il servo del robot), in cloud
 * non avrebbero nulla da ispezionare, e un link pubblico brucerebbe la API key
 * a chiunque passi. Ma la UI merita di essere mostrata in movimento — la
 * gutter che si riempie, la faccia che cambia stato — e quel movimento nasce
 * dagli eventi dello stream. Se gli eventi sono un protocollo, il trasporto è
 * intercambiabile: qui li si cattura una volta, e il frontend li rilegge da un
 * file invece che dalla rete.
 *
 * Cosa NON è: non sono risposte scritte a mano. Sono gli eventi realmente
 * emessi dal backend, con i tempi realmente misurati. Se un domani il modello
 * risponderà meglio, si rilancia questo script.
 *
 * Sta in `scripts/` e non in `src/` perché non importa NIENTE dal backend:
 * parla solo HTTP. Gli script che importano da `src/` vanno invece compilati e
 * lanciati da `dist/` (vedi il registro delle trappole: Node non riscrive `.js`
 * in `.ts` negli import).
 *
 *   npm run demo:record            # contro localhost:3000
 *   CLAUDIO_URL=... npm run demo:record
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BASE = process.env.CLAUDIO_URL ?? 'http://localhost:3000';
const USCITA = join(import.meta.dirname, '..', 'web', 'src', 'demo', 'recordings.json');

/**
 * Le domande della vetrina, scelte per mostrare una capacità diversa ciascuna:
 * uno strumento di sistema, il RAG sul codice, l'hardware del robot, e due
 * strumenti nello stesso turno.
 *
 * L'ordine conta: è quello in cui compaiono nella schermata iniziale.
 */
const DOMANDE = [
  'Il Postgres del progetto è su?',
  'Come funziona la summary memory in questo progetto?',
  'Muovi il servomotore a 90 gradi',
  'Controlla i container e intanto porta il servo a 45 gradi',
];

interface EventoRegistrato {
  /** Millisecondi trascorsi dall'evento precedente: è il ritmo, non l'orario. */
  afterMs: number;
  event: unknown;
}

async function registra(domanda: string): Promise<EventoRegistrato[]> {
  const risposta = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Nessun conversationId: ogni domanda apre una conversazione sua, così le
    // registrazioni sono indipendenti e si possono riprodurre in ogni ordine.
    body: JSON.stringify({ message: domanda }),
  });

  if (!risposta.ok || !risposta.body) {
    throw new Error(`Il server ha risposto ${risposta.status} a "${domanda}".`);
  }

  const eventi: EventoRegistrato[] = [];
  const reader = risposta.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let precedente = Date.now();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const riga = frame.trim();
      if (!riga.startsWith('data:')) continue;

      const adesso = Date.now();
      eventi.push({
        afterMs: adesso - precedente,
        event: JSON.parse(riga.slice(5).trim()),
      });
      precedente = adesso;
    }
  }

  return eventi;
}

async function main(): Promise<void> {
  // L'inventario va registrato insieme alle conversazioni: la schermata
  // iniziale lo legge da `/chat/meta`, che nella demo non esiste. Senza,
  // la vetrina mostrerebbe una schermata iniziale mutilata proprio nel punto
  // in cui elenca di cosa è capace.
  const meta = await fetch(`${BASE}/chat/meta`).then((r) => r.json());

  const conversations = [];
  for (const domanda of DOMANDE) {
    process.stdout.write(`registro: ${domanda}\n`);
    const events = await registra(domanda);
    const durata = events.reduce((somma, e) => somma + e.afterMs, 0);
    process.stdout.write(`  ${events.length} eventi in ${durata} ms\n`);
    conversations.push({ question: domanda, events });
  }

  await mkdir(dirname(USCITA), { recursive: true });
  await writeFile(
    USCITA,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), meta, conversations },
      null,
      2,
    ) + '\n',
  );

  process.stdout.write(`\nScritto ${USCITA}\n`);
}

await main();
