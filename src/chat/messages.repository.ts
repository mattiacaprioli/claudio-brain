import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export type MessageRole = 'user' | 'assistant';

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
}

/** Lo stato della memoria di una conversazione. */
export interface ConversationMemory {
  summary: string | null;
  /** id dell'ultimo messaggio incluso nel riassunto (null = mai riassunto). */
  summaryThroughMessageId: string | null;
}

export interface ConversationStats {
  userMessages: number;
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  hasSummary: boolean;
  summarizedMessages: number;
}

/**
 * Tutto il SQL dell'applicazione vive qui. Il resto del codice non sa che
 * esiste Postgres: in Fase 2 potremo cambiare le query senza toccare i service.
 */
@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  async createConversation(title: string | null): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      `insert into conversations (title) values ($1) returning id`,
      [title],
    );
    return rows[0].id;
  }

  async conversationExists(conversationId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `select id from conversations where id = $1`,
      [conversationId],
    );
    return rows.length > 0;
  }

  async insertMessage(message: {
    conversationId: string;
    role: MessageRole;
    content: string;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  }): Promise<void> {
    await this.db.query(
      `insert into messages
         (conversation_id, role, content, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        message.conversationId,
        message.role,
        message.content,
        message.model ?? null,
        message.inputTokens ?? null,
        message.outputTokens ?? null,
        message.cacheReadTokens ?? null,
        message.cacheCreationTokens ?? null,
      ],
    );
  }

  /** Stato della memoria: riassunto attuale e fin dove arriva. */
  async getMemory(conversationId: string): Promise<ConversationMemory> {
    const rows = await this.db.query<{
      summary: string | null;
      summary_through_message_id: string | null;
    }>(
      `select summary, summary_through_message_id
       from conversations where id = $1`,
      [conversationId],
    );
    return {
      summary: rows[0]?.summary ?? null,
      summaryThroughMessageId: rows[0]?.summary_through_message_id ?? null,
    };
  }

  /**
   * Buffer memory: gli ultimi `limit` messaggi NON ancora riassunti, in ordine
   * cronologico.
   *
   * Due dettagli non ovvi:
   *
   * 1. `afterId` esclude ciò che è già dentro il riassunto: senza questo
   *    filtro pagheremmo due volte lo stesso contenuto (una compresso e una
   *    testuale) e il modello leggerebbe tutto in doppio.
   *
   * 2. Prendiamo gli ULTIMI `limit` (order by desc + reverse), non i primi.
   *    Se la sintesi fallisse più volte di seguito, i messaggi non riassunti
   *    potrebbero superare la finestra: prendendo i primi butteremmo via la
   *    domanda appena arrivata — cioè proprio quella a cui rispondere.
   */
  async findRecentMessagesAfter(
    conversationId: string,
    afterId: string | null,
    limit: number,
  ): Promise<StoredMessage[]> {
    return this.db.query<StoredMessage>(
      `select * from (
         select id, role, content, model, input_tokens, output_tokens, created_at
         from messages
         where conversation_id = $1
           and ($2::bigint is null or id > $2::bigint)
         order by id desc
         limit $3
       ) as recent
       order by id asc`,
      [conversationId, afterId, limit],
    );
  }

  /** Tutti i messaggi non ancora riassunti (serve al riassuntore). */
  async findMessagesAfter(
    conversationId: string,
    afterId: string | null,
  ): Promise<StoredMessage[]> {
    return this.db.query<StoredMessage>(
      `select id, role, content, model, input_tokens, output_tokens, created_at
       from messages
       where conversation_id = $1
         and ($2::bigint is null or id > $2::bigint)
       order by id asc`,
      [conversationId, afterId],
    );
  }

  async saveSummary(
    conversationId: string,
    summary: string,
    throughMessageId: string,
  ): Promise<void> {
    await this.db.query(
      `update conversations
       set summary = $2, summary_through_message_id = $3, updated_at = now()
       where id = $1`,
      [conversationId, summary, throughMessageId],
    );
  }

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    return this.db.query<StoredMessage>(
      `select id, role, content, model, input_tokens, output_tokens, created_at
       from messages
       where conversation_id = $1
       order by id asc`,
      [conversationId],
    );
  }

  /**
   * Contabilità della conversazione.
   *
   * `count(*) filter (where ...)` è l'aggregazione condizionale di Postgres:
   * un solo passaggio sulla tabella invece di una query per ogni contatore.
   * Le somme di interi tornano come stringhe (bigint non entra in un Number
   * JS in sicurezza), quindi la conversione è esplicita.
   */
  async getStats(conversationId: string): Promise<ConversationStats> {
    // I contatori e le somme tornano come STRINGHE (sono bigint: non entrano
    // in un Number JS in sicurezza), mentre bool_or torna come boolean vero.
    const rows = await this.db.query<{
      user_messages: string;
      assistant_messages: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_creation_tokens: string;
      summarized_messages: string;
      has_summary: boolean | null;
    }>(
      `select
         count(*) filter (where m.role = 'user')                as user_messages,
         count(*) filter (where m.role = 'assistant')           as assistant_messages,
         coalesce(sum(m.input_tokens), 0)                       as input_tokens,
         coalesce(sum(m.output_tokens), 0)                      as output_tokens,
         coalesce(sum(m.cache_read_tokens), 0)                  as cache_read_tokens,
         coalesce(sum(m.cache_creation_tokens), 0)              as cache_creation_tokens,
         count(*) filter (
           where c.summary_through_message_id is not null
             and m.id <= c.summary_through_message_id
         )                                                      as summarized_messages,
         bool_or(c.summary is not null)                         as has_summary
       from conversations c
       left join messages m on m.conversation_id = c.id
       where c.id = $1`,
      [conversationId],
    );

    const row = rows[0];
    return {
      userMessages: Number(row?.user_messages ?? 0),
      assistantMessages: Number(row?.assistant_messages ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row?.cache_creation_tokens ?? 0),
      summarizedMessages: Number(row?.summarized_messages ?? 0),
      hasSummary: row?.has_summary === true,
    };
  }

  async touchConversation(conversationId: string): Promise<void> {
    await this.db.query(
      `update conversations set updated_at = now() where id = $1`,
      [conversationId],
    );
  }
}
