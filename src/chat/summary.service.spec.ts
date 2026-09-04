import type { ConfigService } from '@nestjs/config';
import type { LlmService } from '../llm/llm.service.js';
import type {
  ConversationMemory,
  MessagesRepository,
  StoredMessage,
} from './messages.repository.js';
import { SummaryService } from './summary.service.js';
import { conversation } from './testing/message-fixtures.js';

/** Config finta: trigger 20, keepRecent 8, window 20 (i default). */
const CONFIG = { get: () => undefined } as unknown as ConfigService;

function buildFakes(pending: StoredMessage[], memory?: ConversationMemory) {
  const saved: Array<{ summary: string; throughId: string }> = [];

  const repo = {
    getMemory: vi.fn(
      async () => memory ?? { summary: null, summaryThroughMessageId: null },
    ),
    findMessagesAfter: vi.fn(async () => pending),
    saveSummary: vi.fn(async (_id: string, summary: string, throughId: string) => {
      saved.push({ summary, throughId });
    }),
  } as unknown as MessagesRepository;

  const llm = {
    complete: vi.fn(async () => ({
      text: 'RIASSUNTO: Mattia usa NestJS.',
      model: 'claude-haiku-4-5',
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })),
  } as unknown as LlmService;

  return { service: new SummaryService(repo, llm, CONFIG), repo, llm, saved };
}

describe('SummaryService', () => {
  it('non fa nulla (e non spende) sotto la soglia', async () => {
    const { service, llm } = buildFakes(conversation(20));

    expect(await service.maybeSummarize('c1')).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('riassume superata la soglia, lasciando testuali gli ultimi 8', async () => {
    // 21 messaggi non riassunti: 21 - 8 = 13 vanno compressi.
    const { service, saved, llm } = buildFakes(conversation(21));

    expect(await service.maybeSummarize('c1')).toBe(true);
    expect(llm.complete).toHaveBeenCalledOnce();

    // Il confine registrato è l'id dell'ultimo messaggio compresso: dal
    // prossimo turno la finestra ripartirà da qui.
    expect(saved).toEqual([
      { summary: 'RIASSUNTO: Mattia usa NestJS.', throughId: '13' },
    ]);
  });

  it('usa il modello economico e effort basso, senza caching', async () => {
    const { service, llm } = buildFakes(conversation(21));

    await service.maybeSummarize('c1');

    expect(vi.mocked(llm.complete).mock.calls[0][1]).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      cache: false,
    });
  });

  it('è rolling: fonde il riassunto precedente nei nuovi messaggi', async () => {
    const { service, llm } = buildFakes(conversation(21), {
      summary: 'Mattia preferisce SQL a mano, nessun ORM.',
      summaryThroughMessageId: '30',
    });

    await service.maybeSummarize('c1');

    const [messages] = vi.mocked(llm.complete).mock.calls[0];
    const prompt = String(messages[0].content);
    // Il vecchio riassunto DEVE entrare nel prompt: se lo ignorassimo, ad ogni
    // compressione perderemmo i fatti più antichi (erosione della memoria).
    expect(prompt).toContain('Mattia preferisce SQL a mano, nessun ORM.');
    expect(prompt).toContain('<nuovi_messaggi>');
  });

  it('non riassume se dopo aver tenuto gli ultimi 8 non resta nulla', async () => {
    // 8 messaggi, tutti da tenere: niente da comprimere.
    const { service, llm } = buildFakes(conversation(8));

    expect(await service.maybeSummarize('c1')).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
