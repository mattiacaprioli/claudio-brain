import type { ConfigService } from '@nestjs/config';

export interface MemoryConfig {
  /** Quanti messaggi recenti (non riassunti) rimandiamo al modello. */
  historyWindow: number;
  /** Oltre quanti messaggi non riassunti scatta la sintesi. */
  summaryTrigger: number;
  /** Quanti messaggi restano testuali dopo una sintesi. */
  summaryKeepRecent: number;
}

/**
 * Legge e VALIDA i tre parametri della memoria.
 *
 * L'invariante che questa funzione difende:
 *
 *     summaryKeepRecent  <  summaryTrigger  <=  historyWindow
 *
 * Perché è importante. Se `summaryTrigger` fosse maggiore di `historyWindow`,
 * i messaggi non riassunti potrebbero diventare più di quelli che la finestra
 * riesce a spedire: quelli in mezzo non sarebbero né nel riassunto né nella
 * finestra. Sparirebbero, in silenzio, e l'assistente sembrerebbe "smemorato"
 * a caso — il tipo di bug che si scopre tre settimane dopo. Meglio non far
 * partire l'applicazione.
 */
export function loadMemoryConfig(config: ConfigService): MemoryConfig {
  const memory: MemoryConfig = {
    historyWindow: Number(config.get<string>('HISTORY_WINDOW') ?? 20),
    summaryTrigger: Number(config.get<string>('SUMMARY_TRIGGER') ?? 20),
    summaryKeepRecent: Number(config.get<string>('SUMMARY_KEEP_RECENT') ?? 8),
  };

  if (memory.summaryTrigger > memory.historyWindow) {
    throw new Error(
      `Configurazione memoria incoerente: SUMMARY_TRIGGER (${memory.summaryTrigger}) ` +
        `non può superare HISTORY_WINDOW (${memory.historyWindow}), ` +
        'altrimenti alcuni messaggi non finirebbero né nel riassunto né nella finestra.',
    );
  }
  if (memory.summaryKeepRecent >= memory.summaryTrigger) {
    throw new Error(
      `Configurazione memoria incoerente: SUMMARY_KEEP_RECENT (${memory.summaryKeepRecent}) ` +
        `deve essere minore di SUMMARY_TRIGGER (${memory.summaryTrigger}), ` +
        'altrimenti la sintesi scatterebbe ad ogni messaggio.',
    );
  }

  return memory;
}
