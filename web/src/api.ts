import type { ChatStreamEvent, Meta } from './types';

/**
 * Client dello stream.
 *
 * Non usa `EventSource` per un motivo preciso: `EventSource` sa fare solo GET
 * senza corpo, e i messaggi arrivano fino a 20.000 caratteri — non stanno in
 * una URL. Quindi POST + `fetch` + ReadableStream, leggendo il formato SSE a
 * mano. È anche il motivo per cui tutte le chat moderne fanno così.
 *
 * Il parsing ha una sola insidia, ed è il buffer: un chunk della rete non
 * coincide con un evento. Può arrivare mezzo evento, o due e mezzo. Per questo
 * si accumula in `buffer` e si consuma solo fino all'ultimo `\n\n` completo —
 * il resto resta in attesa del chunk successivo. Saltare questo passaggio
 * funziona in locale (dove i chunk sono piccoli e ordinati) e si rompe in rete
 * reale, che è il modo peggiore di scoprirlo.
 */
export async function streamChat(
  body: { message: string; conversationId?: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Il server ha risposto ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    // L'ultimo pezzo può essere incompleto: torna nel buffer.
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
      } catch {
        // Un frame malformato non deve interrompere lo stream: si perde un
        // evento, non la risposta.
      }
    }
  }
}

/** Inventario degli strumenti e stato dell'indice, per la schermata iniziale. */
export async function fetchMeta(): Promise<Meta> {
  const response = await fetch('/chat/meta');
  if (!response.ok) throw new Error(`Il server ha risposto ${response.status}.`);
  return response.json() as Promise<Meta>;
}

/** Contabilità della conversazione, per il pannello di stato. */
export async function fetchStats(conversationId: string) {
  const response = await fetch(`/chat/${conversationId}/stats`);
  if (!response.ok) throw new Error(`Il server ha risposto ${response.status}.`);
  return response.json() as Promise<{
    userMessages: number;
    assistantMessages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    estimatedCostUsd: number;
    hasSummary: boolean;
  }>;
}
