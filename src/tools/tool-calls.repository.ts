import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { ToolExecution } from './tools.service.js';

export interface StoredToolCall {
  id: string;
  tool_use_id: string;
  name: string;
  input: unknown;
  output: string | null;
  is_error: boolean;
  duration_ms: number | null;
  created_at: Date;
}

@Injectable()
export class ToolCallsRepository {
  constructor(private readonly db: DatabaseService) {}

  async record(
    conversationId: string,
    executions: ToolExecution[],
  ): Promise<void> {
    if (executions.length === 0) return;

    for (const execution of executions) {
      await this.db.query(
        `insert into tool_calls
           (conversation_id, tool_use_id, name, input, output, is_error, duration_ms)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          conversationId,
          execution.toolUseId,
          execution.name,
          // jsonb vuole una stringa JSON: il driver non serializza gli oggetti.
          JSON.stringify(execution.input ?? {}),
          execution.result.content,
          execution.result.isError,
          execution.durationMs,
        ],
      );
    }
  }

  async listByConversation(conversationId: string): Promise<StoredToolCall[]> {
    return this.db.query<StoredToolCall>(
      `select id, tool_use_id, name, input, output, is_error, duration_ms, created_at
       from tool_calls
       where conversation_id = $1
       order by id asc`,
      [conversationId],
    );
  }
}
