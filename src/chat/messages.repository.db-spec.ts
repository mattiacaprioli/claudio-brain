import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagesRepository } from './messages.repository.js';

/**
 * Test di INTEGRAZIONE: gira contro il Postgres di docker-compose.
 *   npm run db:up && npm run db:migrate && npm run test:db
 *
 * Perché serve, se i test unitari sono già verdi: quelli usano un repository
 * finto, quindi non dicono niente sul fatto che le query siano SQL valido.
 * Il compilatore TypeScript nemmeno guarda dentro le stringhe SQL. L'unico
 * modo di sapere che `$2::bigint is null or id > $2::bigint` funziona è
 * mandarlo a Postgres.
 */
describe('MessagesRepository (Postgres vero)', () => {
  let repo: MessagesRepository;
  let db: DatabaseService;
  const conversationIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [MessagesRepository],
    }).compile();

    repo = moduleRef.get(MessagesRepository);
    db = moduleRef.get(DatabaseService);
  });

  afterAll(async () => {
    // Pulizia: `on delete cascade` sulla foreign key porta via anche i messaggi.
    for (const id of conversationIds) {
      await db.query('delete from conversations where id = $1', [id]);
    }
    await db.onModuleDestroy();
  });

  async function seedConversation(messageCount: number): Promise<string> {
    const id = await repo.createConversation('test');
    conversationIds.push(id);
    for (let index = 0; index < messageCount; index += 1) {
      await repo.insertMessage({
        conversationId: id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `messaggio ${index + 1}`,
        inputTokens: index % 2 === 0 ? null : 1000,
        outputTokens: index % 2 === 0 ? null : 200,
        cacheReadTokens: index % 2 === 0 ? null : 800,
        cacheCreationTokens: index % 2 === 0 ? null : 100,
      });
    }
    return id;
  }

  it('conversazione nuova: nessun riassunto, nessun messaggio', async () => {
    const id = await seedConversation(0);

    expect(await repo.getMemory(id)).toEqual({
      summary: null,
      summaryThroughMessageId: null,
    });
    expect(await repo.findRecentMessagesAfter(id, null, 20)).toEqual([]);
  });

  it('findRecentMessagesAfter restituisce gli ULTIMI n, in ordine cronologico', async () => {
    const id = await seedConversation(30);

    const recent = await repo.findRecentMessagesAfter(id, null, 5);

    expect(recent.map((m) => m.content)).toEqual([
      'messaggio 26',
      'messaggio 27',
      'messaggio 28',
      'messaggio 29',
      'messaggio 30',
    ]);
  });

  it('dopo un riassunto esclude i messaggi già compressi', async () => {
    const id = await seedConversation(10);
    const all = await repo.listMessages(id);
    const boundary = all[5].id; // riassumiamo i primi 6

    await repo.saveSummary(id, 'riassunto dei primi sei', boundary);

    expect(await repo.getMemory(id)).toEqual({
      summary: 'riassunto dei primi sei',
      summaryThroughMessageId: boundary,
    });

    const recent = await repo.findRecentMessagesAfter(id, boundary, 20);
    expect(recent.map((m) => m.content)).toEqual([
      'messaggio 7',
      'messaggio 8',
      'messaggio 9',
      'messaggio 10',
    ]);
  });

  it('se i non riassunti superano la finestra tiene i più RECENTI', async () => {
    // Il caso degenere: la sintesi ha fallito e sono rimasti indietro.
    // Tenere i primi vorrebbe dire buttare la domanda appena arrivata.
    const id = await seedConversation(10);

    const recent = await repo.findRecentMessagesAfter(id, null, 3);

    expect(recent.map((m) => m.content)).toEqual([
      'messaggio 8',
      'messaggio 9',
      'messaggio 10',
    ]);
  });

  it('getStats somma token, cache e messaggi riassunti', async () => {
    const id = await seedConversation(10); // 5 user + 5 assistant
    const all = await repo.listMessages(id);
    await repo.saveSummary(id, 'riassunto', all[3].id); // primi 4 compressi

    const stats = await repo.getStats(id);

    expect(stats).toEqual({
      userMessages: 5,
      assistantMessages: 5,
      inputTokens: 5000, // 5 messaggi assistant x 1000
      outputTokens: 1000,
      cacheReadTokens: 4000,
      cacheCreationTokens: 500,
      summarizedMessages: 4,
      hasSummary: true,
    });
  });

  it('il CHECK sul role rifiuta un messaggio di sistema', async () => {
    const id = await seedConversation(0);

    // Il system prompt non è un messaggio: il database lo impedisce.
    await expect(
      db.query(
        `insert into messages (conversation_id, role, content) values ($1, 'system', 'x')`,
        [id],
      ),
    ).rejects.toThrow(/messages_role_check/);
  });
});
