import type Anthropic from '@anthropic-ai/sdk';

/**
 * Esito di un'esecuzione. Sempre una stringa: è ciò che il modello leggerà.
 *
 * `isError` non serve a nascondere il fallimento — serve a DICHIARARLO al
 * modello, che con quell'informazione può correggere gli argomenti e
 * riprovare. Ingoiare un errore e restituire "" è il modo più rapido di far
 * girare a vuoto un agente.
 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/**
 * Uno strumento eseguibile dall'agente.
 *
 * `definition` è ciò che il modello vede (nome, descrizione, schema degli
 * argomenti); `execute` è ciò che gira sulla nostra macchina. La descrizione
 * non è documentazione per noi: è **l'unica** cosa in base a cui il modello
 * decide se e quando usare lo strumento. Una descrizione vaga produce un
 * agente che chiama il tool sbagliato.
 */
export interface AgentTool {
  readonly definition: Anthropic.Tool;
  execute(input: unknown): Promise<ToolResult>;
}

/** Token di iniezione multipla: raccoglie tutti gli strumenti registrati. */
export const AGENT_TOOLS = 'AGENT_TOOLS';

/**
 * Errore di validazione degli argomenti.
 *
 * Gli argomenti di un tool arrivano da un MODELLO, non da un client
 * tipizzato: sono input non fidato quanto quello di un utente anonimo. Ogni
 * tool li valida da sé e questo errore diventa un `tool_result` con
 * `is_error: true`, così il modello vede cosa ha sbagliato invece di ricevere
 * un 500 opaco.
 */
export class ToolInputError extends Error {}

/** Tronca l'output così un comando verboso non riempie la context window. */
export function truncateOutput(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return (
    `${text.slice(0, maxChars)}\n\n[...output troncato: ${text.length - maxChars} caratteri omessi]`
  );
}
