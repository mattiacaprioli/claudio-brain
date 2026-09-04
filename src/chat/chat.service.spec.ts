import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { LlmService } from '../llm/llm.service.js';
import { ChatService } from './chat.service.js';
import type {
  ConversationMemory,
  MessagesRepository,
  StoredMessage,
} from './messages.repository.js';
import type { SearchHit } from '../rag/rag.repository.js';
import type { RagService } from '../rag/rag.service.js';
import type { SummaryService } from './summary.service.js';
import { makeStoredMessage } from './testing/message-fixtures.js';

/**
 * Questi test verificano LA MEMORIA, non l'LLM.
 *
 * Sostituiamo repository, LlmService e SummaryService con dei finti: nessuna
 * chiamata di rete, nessun database, nessun costo. È il vantaggio di aver
 * tenuto la logica nel service invece che nel controller — e il motivo per cui
 * le dipendenze sono iniettate e non istanziate dentro ChatService.
 */

const NO_MEMORY: ConversationMemory = {
  summary: null,
  summaryThroughMessageId: null,
};

describe('ChatService', () => {
  function buildFakes(
    options: {
      recent?: StoredMessage[];
      memory?: ConversationMemory;
      hits?: SearchHit[];
    } = {},
  ) {
    const inserted: Array<{ role: string; content: string }> = [];

    const repo = {
      createConversation: vi.fn(async () => 'new-conversation-id'),
      conversationExists: vi.fn(async (id: string) => id === 'existing-id'),
      insertMessage: vi.fn(async (m: { role: string; content: string }) => {
        inserted.push({ role: m.role, content: m.content });
      }),
      getMemory: vi.fn(async () => options.memory ?? NO_MEMORY),
      findRecentMessagesAfter: vi.fn(async () => options.recent ?? []),
      touchConversation: vi.fn(async () => undefined),
    } as unknown as MessagesRepository;

    const llm = {
      complete: vi.fn(async () => ({
        text: 'risposta finta',
        model: 'claude-opus-5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })),
    } as unknown as LlmService;

    const summaries = {
      maybeSummarize: vi.fn(async () => false),
    } as unknown as SummaryService;

    const hits = options.hits ?? [];
    const rag = {
      enabled: hits.length > 0,
      search: vi.fn(async () => hits),
      // Riusiamo la formattazione vera: se cambia il formato del contesto,
      // i test che verificano l'ordine dei messaggi restano validi.
      buildContext: (found: SearchHit[]) =>
        found.length === 0 ? '' : `<contesto_recuperato>${found.length}</contesto_recuperato>`,
    } as unknown as RagService;

    const config = { get: () => undefined } as unknown as ConfigService;

    return {
      service: new ChatService(repo, llm, summaries, rag, config),
      repo,
      llm,
      summaries,
      rag,
      inserted,
    };
  }

  function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
      id: '1',
      source: 'code',
      path: 'src/chat/chat.service.ts',
      start_line: 10,
      end_line: 40,
      symbol: 'ChatService.sendMessage',
      content: 'codice recuperato',
      score: 0.03,
      semantic_rank: 1,
      keyword_rank: 2,
      ...overrides,
    };
  }

  it('manda al modello TUTTO lo storico, in ordine cronologico', async () => {
    // Lo storico che il DB restituirà: 2 turni passati + la domanda di adesso.
    const { service, llm } = buildFakes({
      recent: [
        makeStoredMessage(1, 'user', 'Mi chiamo Mattia'),
        makeStoredMessage(2, 'assistant', 'Ciao Mattia!'),
        makeStoredMessage(3, 'user', 'Come mi chiamo?'),
      ],
    });

    await service.sendMessage({
      message: 'Come mi chiamo?',
      conversationId: 'existing-id',
    });

    // Questa asserzione È il concetto di statelessness: il modello non ricorda
    // nulla, quindi il ricordo "mi chiamo Mattia" deve essere nella richiesta.
    expect(llm.complete).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'Mi chiamo Mattia' },
        { role: 'assistant', content: 'Ciao Mattia!' },
        { role: 'user', content: 'Come mi chiamo?' },
      ],
      { cache: true },
    );
  });

  it('mette il riassunto in testa alla richiesta, prima dei messaggi recenti', async () => {
    const { service, llm } = buildFakes({
      memory: { summary: 'Mattia usa NestJS e Postgres.', summaryThroughMessageId: '40' },
      recent: [makeStoredMessage(41, 'user', 'Riprendiamo da dove eravamo')],
    });

    await service.sendMessage({
      message: 'Riprendiamo da dove eravamo',
      conversationId: 'existing-id',
    });

    const [messages] = vi.mocked(llm.complete).mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('Mattia usa NestJS e Postgres.');
    expect(messages[1].content).toBe('Riprendiamo da dove eravamo');
  });

  it('chiede al DB solo i messaggi NON ancora riassunti', async () => {
    const { service, repo } = buildFakes({
      memory: { summary: 'riassunto', summaryThroughMessageId: '40' },
    });

    await service.sendMessage({ message: 'ciao', conversationId: 'existing-id' });

    // Il '40' è il confine: senza questo filtro pagheremmo due volte lo stesso
    // contenuto, una volta compresso e una volta testuale.
    expect(repo.findRecentMessagesAfter).toHaveBeenCalledWith('existing-id', '40', 20);
  });

  it('attiva il prompt caching sulla chiamata di chat', async () => {
    const { service, llm } = buildFakes();

    await service.sendMessage({ message: 'ciao' });

    expect(vi.mocked(llm.complete).mock.calls[0][1]).toEqual({ cache: true });
  });

  it('salva prima la domanda e poi la risposta', async () => {
    const { service, inserted } = buildFakes();

    await service.sendMessage({ message: 'ciao' });

    expect(inserted).toEqual([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'risposta finta' },
    ]);
  });

  it('crea una nuova conversazione se non arriva un conversationId', async () => {
    const { service, repo } = buildFakes();

    const result = await service.sendMessage({ message: 'primo messaggio' });

    expect(repo.createConversation).toHaveBeenCalled();
    expect(result.conversationId).toBe('new-conversation-id');
  });

  it('non perde la domanda dell utente se l LLM fallisce', async () => {
    const { service, llm, inserted } = buildFakes();
    vi.mocked(llm.complete).mockRejectedValueOnce(new Error('provider down'));

    await expect(service.sendMessage({ message: 'domanda importante' })).rejects.toThrow(
      'provider down',
    );

    // La domanda è già a database: al retry non va riscritta a mano.
    expect(inserted).toEqual([{ role: 'user', content: 'domanda importante' }]);
  });

  it('risponde comunque se la sintesi in background fallisce', async () => {
    const { service, summaries } = buildFakes();
    vi.mocked(summaries.maybeSummarize).mockRejectedValueOnce(new Error('haiku down'));

    // La sintesi serve dal turno DOPO: un suo errore non deve rompere questo turno.
    const result = await service.sendMessage({ message: 'ciao' });

    expect(result.reply).toBe('risposta finta');
  });

  describe('con il RAG attivo', () => {
    const storico = [
      makeStoredMessage(1, 'user', 'domanda vecchia'),
      makeStoredMessage(2, 'assistant', 'risposta vecchia'),
      makeStoredMessage(3, 'user', 'dove sta sendMessage?'),
    ];

    it('mette i frammenti PRIMA della domanda, non in coda', async () => {
      const { service, llm } = buildFakes({ recent: storico, hits: [makeHit()] });

      await service.sendMessage({
        message: 'dove sta sendMessage?',
        conversationId: 'existing-id',
      });

      const [messages] = vi.mocked(llm.complete).mock.calls[0];
      // storico(2) + contesto(1) + domanda(1)
      expect(messages).toHaveLength(4);
      expect(String(messages[2].content)).toContain('contesto_recuperato');
      expect(messages[3].content).toBe('dove sta sendMessage?');
    });

    it('usa un breakpoint di cache ESPLICITO sull ultimo messaggio stabile', async () => {
      const { service, llm } = buildFakes({ recent: storico, hits: [makeHit()] });

      await service.sendMessage({
        message: 'dove sta sendMessage?',
        conversationId: 'existing-id',
      });

      // Indice 1 = ultimo messaggio dello storico, cioè la fine del prefisso
      // stabile. Il caching automatico metterebbe il breakpoint in coda, dopo
      // i frammenti: pagheremmo la scrittura su byte mai riletti.
      expect(vi.mocked(llm.complete).mock.calls[0][1]).toEqual({ cacheUpToIndex: 1 });
    });

    it('non mette breakpoint se non c è ancora prefisso stabile', async () => {
      const { service, llm } = buildFakes({
        recent: [makeStoredMessage(1, 'user', 'prima domanda')],
        hits: [makeHit()],
      });

      await service.sendMessage({ message: 'prima domanda' });

      // Un solo messaggio: niente da cachare, e un breakpoint su un prefisso
      // vuoto sarebbe solo un costo di scrittura.
      expect(vi.mocked(llm.complete).mock.calls[0][1]).toEqual({ cache: true });
    });

    it('riporta i frammenti recuperati e da quale metà arrivano', async () => {
      const { service } = buildFakes({
        recent: storico,
        hits: [
          makeHit({ semantic_rank: 1, keyword_rank: 1 }),
          makeHit({ id: '2', semantic_rank: null, keyword_rank: 3 }),
          makeHit({ id: '3', semantic_rank: 2, keyword_rank: null }),
        ],
      });

      const result = await service.sendMessage({
        message: 'dove sta sendMessage?',
        conversationId: 'existing-id',
      });

      // Rende verificabile su cosa si è basata la risposta: un RAG che non
      // dice da dove viene ciò che dice non è controllabile.
      expect(result.retrieved.map((item) => item.foundBy)).toEqual([
        'entrambe',
        'full-text',
        'semantica',
      ]);
      expect(result.retrieved[0].lines).toBe('10-40');
    });
  });

  it('risponde 404 se il conversationId non esiste', async () => {
    const { service } = buildFakes();

    await expect(
      service.sendMessage({ message: 'ciao', conversationId: 'unknown-id' }),
    ).rejects.toThrow(NotFoundException);
  });
});
