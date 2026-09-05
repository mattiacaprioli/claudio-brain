import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Face, type FaceState } from './components/Face';
import { Rail } from './components/Rail';
import { renderMarkdown } from './markdown';
import {
  ESEMPI,
  isReplay,
  loadMeta,
  RegistrazioneMancante,
  registratoIl,
  streamMessage,
} from './transport';
import type { ChatStreamEvent, Meta, Turn } from './types';

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Meta>();
  // La faccia non ha una macchina a stati sua: è una lettura dello stesso
  // switch che aggiorna la trascrizione, quindi non può divergere da ciò che
  // sta davvero accadendo.
  const [face, setFace] = useState<FaceState>('idle');
  const abort = useRef<AbortController>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // L'inventario è dato reale, non testo scritto a mano: se domani si
  // aggiunge uno strumento, la schermata iniziale lo annuncia da sé.
  useEffect(() => {
    void loadMeta()
      .then(setMeta)
      .catch(() => setMeta(undefined));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  /** Applica un evento all'ultimo turno dell'assistente. */
  const patchLast = (patch: (turn: Turn) => Turn) => {
    setTurns((previous) => {
      const next = [...previous];
      const index = next.length - 1;
      if (index >= 0) next[index] = patch(next[index]);
      return next;
    });
  };

  const handleEvent = (event: ChatStreamEvent) => {
    switch (event.type) {
      case 'conversation':
        setConversationId(event.conversationId);
        break;

      case 'retrieval':
        patchLast((turn) => ({ ...turn, fragments: event.fragments }));
        setFace('reading');
        break;

      case 'text':
        // Il testo si accumula: ogni evento è un pezzo, non la risposta.
        patchLast((turn) => ({ ...turn, text: turn.text + event.text }));
        setFace('speaking');
        break;

      case 'tool_start':
        setFace('working');
        patchLast((turn) => ({
          ...turn,
          tools: [
            ...(turn.tools ?? []),
            { id: event.id, name: event.name, input: event.input },
          ],
        }));
        break;

      case 'tool_end':
        // Torna a ragionare: ha il risultato in mano e deve decidere che
        // farne. Se chiede subito un altro strumento, `tool_start` rientra.
        setFace('thinking');
        patchLast((turn) => ({
          ...turn,
          tools: (turn.tools ?? []).map((tool) =>
            tool.id === event.id
              ? {
                  ...tool,
                  durationMs: event.durationMs,
                  isError: event.isError,
                  preview: event.preview,
                }
              : tool,
          ),
        }));
        break;

      case 'done':
        patchLast((turn) => ({ ...turn, usage: event.usage, streaming: false }));
        setFace('idle');
        break;

      case 'error':
        patchLast((turn) => ({ ...turn, error: event.message, streaming: false }));
        setFace('error');
        break;

      case 'iteration':
        // Il numero di giro arriva alla fine dentro `usage`: qui non serve
        // mostrarlo, i tool nel binario già raccontano cosa sta accadendo.
        //
        // E la faccia NON deve reagire a questo evento, per quanto sembri il
        // candidato naturale per "sta pensando": `chat.service.ts` emette
        // `retrieval` subito prima di avviare l'agente, e `agent.service.ts`
        // emette `iteration` come primissima cosa del giro. I due arrivano a
        // pochi millisecondi di distanza, quindi legare qui lo stato
        // cancellerebbe lo sguardo che scorre prima che si veda. `reading`
        // deve durare fino al primo `text` o `tool_start`.
        break;
    }
  };

  const send = async (message: string) => {
    setTurns((previous) => [
      ...previous,
      { role: 'user', text: message },
      { role: 'assistant', text: '', streaming: true },
    ]);
    setBusy(true);
    setFace('thinking');

    const controller = new AbortController();
    abort.current = controller;

    try {
      await streamMessage({ message, conversationId }, handleEvent, controller.signal);
    } catch (error) {
      if (error instanceof RegistrazioneMancante) {
        // Non è un guasto, ed è importante che non lo sembri: in demo la
        // domanda libera non ha una risposta registrata. Inventarne una
        // sarebbe l'unica bugia possibile in una pagina fatta di eventi veri.
        patchLast((turn) => ({
          ...turn,
          note: 'Questa è una demo registrata: posso riprodurre solo le conversazioni catturate dal backend vero. Provane una:',
          streaming: false,
        }));
        setFace('idle');
      } else if (!controller.signal.aborted) {
        patchLast((turn) => ({
          ...turn,
          error: (error as Error).message,
          streaming: false,
        }));
        setFace('error');
      }
    } finally {
      // Se l'utente ha fermato, il testo ricevuto fin lì resta: è comunque
      // una risposta parziale utile, non spazzatura da cancellare.
      patchLast((turn) => ({ ...turn, streaming: false }));
      // L'errore resta sulla faccia fino al messaggio successivo: la chiusura
      // dello stream non è una buona notizia da cui ripartire sereni.
      setFace((previous) => (previous === 'error' ? 'error' : 'idle'));
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="identity">
          <Face state={face} />
          <div className="identity-text">
            <h1 className="brand">claudio</h1>
            <p className="brand-note">
              {isReplay
                ? 'demo registrata · il backend gira sul robot'
                : 'assistente locale del progetto'}
            </p>
          </div>
        </div>
        {/* Badge e id stanno nello stesso contenitore perché occupano la
            stessa cella della griglia: due elementi con `justify-self: start`
            in colonna 2 si sovrapporrebbero. */}
        <div className="header-meta">
          {isReplay ? (
            <span
              className="demo-badge"
              title={`Eventi catturati da conversazioni reali il ${new Date(registratoIl()).toLocaleDateString('it-IT')}. Le pause più lunghe di 1,8 s sono accorciate.`}
            >
              registrata
            </span>
          ) : null}
          {conversationId ? (
            <span className="conversation-id" title="Id della conversazione">
              {conversationId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      </header>

      <main className="transcript">
        {turns.length === 0 ? (
          <section className="empty">
            <div className="inventory">
              {meta ? (
                <>
                  <div className="inventory-group">
                    <span className="inventory-label">strumenti</span>
                    {meta.tools.map((tool) => (
                      <span className="inventory-item" key={tool.name}>
                        {tool.name}
                      </span>
                    ))}
                  </div>
                  {meta.index.length > 0 ? (
                    <div className="inventory-group">
                      <span className="inventory-label">indice</span>
                      {meta.index.map((source) => (
                        <span className="inventory-item" key={source.source}>
                          {source.source}{' '}
                          <span className="inventory-count">{source.chunks}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className="empty-body">
              <h2>Cosa vuoi sapere?</h2>
              <p>
                Claudio cerca nel codice e nella documentazione di questo progetto,
                controlla lo stato dell'ambiente di sviluppo e comanda l'hardware
                del robot. Ogni passo che compie resta visibile qui a sinistra.
              </p>
              {isReplay ? (
                <p className="demo-nota">
                  Il backend vive sul robot e non è esposto su internet: questa
                  pagina <strong>riproduce eventi reali</strong>, catturati da
                  conversazioni vere il{' '}
                  {new Date(registratoIl()).toLocaleDateString('it-IT')}, con i
                  tempi misurati allora. Le pause più lunghe di 1,8 s sono
                  accorciate — è l'unica cosa che non è com'era.
                </p>
              ) : null}
              <ul className="examples">
                {ESEMPI.map((esempio) => (
                  <li key={esempio}>
                    <button type="button" onClick={() => void send(esempio)}>
                      {esempio}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {turns.map((turn, index) =>
          turn.role === 'user' ? (
            <article className="turn turn-user" key={index}>
              <p>{turn.text}</p>
            </article>
          ) : (
            <article className="turn turn-assistant" key={index}>
              <Rail fragments={turn.fragments} tools={turn.tools} />

              <div className="prose">
                {renderMarkdown(turn.text)}
                {turn.streaming && turn.text.length === 0 ? (
                  <p className="thinking">sta pensando</p>
                ) : null}
                {turn.streaming && turn.text.length > 0 ? (
                  <span className="cursor" aria-hidden="true" />
                ) : null}
              </div>

              {turn.note ? (
                <div className="note">
                  <p>{turn.note}</p>
                  <ul className="examples">
                    {ESEMPI.map((esempio) => (
                      <li key={esempio}>
                        <button type="button" onClick={() => void send(esempio)}>
                          {esempio}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {turn.error ? <p className="failure">{turn.error}</p> : null}

              {turn.usage ? (
                <p className="measures">
                  <span>{turn.usage.outputTokens} token generati</span>
                  <span>{turn.usage.cacheReadTokens} letti da cache</span>
                  <span>{turn.usage.inputTokens} a prezzo pieno</span>
                  {turn.usage.iterations > 1 ? (
                    <span>{turn.usage.iterations} giri</span>
                  ) : null}
                </p>
              ) : null}
            </article>
          ),
        )}
        <div ref={bottom} />
      </main>

      <Composer
        onSend={(message) => void send(message)}
        onStop={() => abort.current?.abort()}
        busy={busy}
        // In demo la casella resta scrivibile di proposito: disabilitarla
        // sembrerebbe una UI rotta, e chi guarda un portfolio prova a
        // scrivere. Il placeholder dice come stanno le cose PRIMA che ci
        // provi, e chi ci prova comunque riceve una nota, non un errore.
        placeholder={
          isReplay
            ? 'Demo registrata: scegli una delle domande qui sopra'
            : undefined
        }
      />
    </div>
  );
}
