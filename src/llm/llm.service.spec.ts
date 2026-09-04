import type Anthropic from '@anthropic-ai/sdk';
import { supportsAdaptiveThinking, withCacheBreakpoint } from './llm.service.js';

describe('supportsAdaptiveThinking', () => {
  it('riconosce i modelli che accettano thinking adaptive ed effort', () => {
    expect(supportsAdaptiveThinking('claude-opus-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
    // I prefissi coprono le varianti puntate.
    expect(supportsAdaptiveThinking('claude-fable-5-1')).toBe(true);
  });

  it('esclude i modelli che li rifiutano con un 400', () => {
    // Il caso che ha rotto il riassuntore: Haiku 4.5 risponde
    // "adaptive thinking is not supported on this model".
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  });

  it('è prudente con un modello sconosciuto', () => {
    // Omettere i parametri funziona sempre; inviarli a sproposito è un 400.
    // Quindi il default per un modello mai visto è "non inviarli".
    expect(supportsAdaptiveThinking('claude-qualcosa-di-nuovo')).toBe(false);
  });
});

describe('withCacheBreakpoint', () => {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: 'primo' },
    { role: 'assistant', content: 'secondo' },
    { role: 'user', content: 'terzo' },
  ];

  it('converte la stringa in blocco e marca l ultimo blocco', () => {
    const marked = withCacheBreakpoint(messages, 1);

    // Il marcatore va su un BLOCCO di contenuto, non sul messaggio: una
    // stringa va prima convertita in un blocco text.
    expect(marked[1].content).toEqual([
      { type: 'text', text: 'secondo', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('non tocca gli altri messaggi né l array originale', () => {
    const marked = withCacheBreakpoint(messages, 1);

    expect(marked[0].content).toBe('primo');
    expect(marked[2].content).toBe('terzo');
    // L'originale resta intatto: mutarlo cambierebbe i messaggi anche per il
    // chiamante, che li usa per altro (log, persistenza).
    expect(messages[1].content).toBe('secondo');
  });

  it('ignora un indice fuori range invece di sollevare', () => {
    expect(withCacheBreakpoint(messages, 9)).toBe(messages);
    expect(withCacheBreakpoint(messages, -1)).toBe(messages);
  });

  it('marca solo l ultimo blocco di un contenuto già a blocchi', () => {
    const conBlocchi: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'contesto' },
          { type: 'text', text: 'domanda' },
        ],
      },
    ];

    const marked = withCacheBreakpoint(conBlocchi, 0);
    const blocks = marked[0].content as Anthropic.ContentBlockParam[];

    expect(blocks[0]).not.toHaveProperty('cache_control');
    expect(blocks[1]).toHaveProperty('cache_control');
  });
});
