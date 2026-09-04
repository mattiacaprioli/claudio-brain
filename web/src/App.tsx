import { useEffect, useRef, useState } from 'react';
import { fetchMeta, streamChat } from './api';
import { Composer } from './components/Composer';
import { Rail } from './components/Rail';
import { renderMarkdown } from './markdown';
import type { ChatStreamEvent, Meta, Turn } from './types';

const ESEMPI = [
  'Il Postgres del progetto è su?',
  'Cosa ho modificato e non ho ancora committato?',
  'Come funziona la summary memory in questo progetto?',
  'Muovi il servomotore a 90 gradi',
];

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Meta>();
  const abort = useRef<AbortController>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // L'inventario è dato reale, non testo scritto a mano: se domani si
  // aggiunge uno strumento, la schermata iniziale lo annuncia da sé.
  useEffect(() => {
    void fetchMeta()
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
        break;

      case 'text':
        // Il testo si accumula: ogni evento è un pezzo, non la risposta.
        patchLast((turn) => ({ ...turn, text: turn.text + event.text }));
        break;

      case 'tool_start':
        patchLast((turn) => ({
          ...turn,
          tools: [
            ...(turn.tools ?? []),
            { id: event.id, name: event.name, input: event.input },
          ],
        }));
        break;

      case 'tool_end':
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
        break;

      case 'error':
        patchLast((turn) => ({ ...turn, error: event.message, streaming: false }));
        break;

      case 'iteration':
        // Il numero di giro arriva alla fine dentro `usage`: qui non serve
        // mostrarlo, i tool nel binario già raccontano cosa sta accadendo.
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

    const controller = new AbortController();
    abort.current = controller;

    try {
      await streamChat({ message, conversationId }, handleEvent, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        patchLast((turn) => ({
          ...turn,
          error: (error as Error).message,
          streaming: false,
        }));
      }
    } finally {
      // Se l'utente ha fermato, il testo ricevuto fin lì resta: è comunque
      // una risposta parziale utile, non spazzatura da cancellare.
      patchLast((turn) => ({ ...turn, streaming: false }));
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">claudio</h1>
        <p className="brand-note">
          assistente locale del progetto
        </p>
        {conversationId ? (
          <span className="conversation-id" title="Id della conversazione">
            {conversationId.slice(0, 8)}
          </span>
        ) : null}
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
      />
    </div>
  );
}
