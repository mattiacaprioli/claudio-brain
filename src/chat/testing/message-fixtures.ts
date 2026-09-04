import type { StoredMessage } from '../messages.repository.js';

/**
 * Fixture condivise fra i test.
 *
 * Sta in un file SENZA `.spec.` per un motivo pratico: importare un file di
 * test da un altro file di test fa rieseguire i suoi `describe`, e i test
 * risultano contati (ed eseguiti) due volte.
 */
export function makeStoredMessage(
  id: number,
  role: 'user' | 'assistant',
  content: string,
): StoredMessage {
  return {
    id: String(id),
    role,
    content,
    model: null,
    input_tokens: null,
    output_tokens: null,
    created_at: new Date(),
  };
}

/** Una conversazione finta di `length` messaggi, alternati user/assistant. */
export function conversation(length: number): StoredMessage[] {
  return Array.from({ length }, (_, index) =>
    makeStoredMessage(
      index + 1,
      index % 2 === 0 ? 'user' : 'assistant',
      `msg ${index + 1}`,
    ),
  );
}
