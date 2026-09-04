import type { ConfigService } from '@nestjs/config';
import { loadMemoryConfig } from './memory.config.js';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadMemoryConfig', () => {
  it('usa i default se .env non dice nulla', () => {
    expect(loadMemoryConfig(config({}))).toEqual({
      historyWindow: 20,
      summaryTrigger: 20,
      summaryKeepRecent: 8,
    });
  });

  it('rifiuta un trigger più grande della finestra', () => {
    // Questa configurazione farebbe sparire in silenzio i messaggi in mezzo:
    // meglio non far partire l'applicazione.
    expect(() =>
      loadMemoryConfig(config({ HISTORY_WINDOW: '10', SUMMARY_TRIGGER: '30' })),
    ).toThrow(/non può superare HISTORY_WINDOW/);
  });

  it('rifiuta keepRecent >= trigger', () => {
    expect(() =>
      loadMemoryConfig(config({ SUMMARY_TRIGGER: '10', SUMMARY_KEEP_RECENT: '10' })),
    ).toThrow(/deve essere minore di SUMMARY_TRIGGER/);
  });
});
