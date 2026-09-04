import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { RagModule } from '../rag/rag.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { AgentService } from './agent.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { MessagesRepository } from './messages.repository.js';
import { SummaryService } from './summary.service.js';

@Module({
  imports: [DatabaseModule, LlmModule, RagModule, ToolsModule],
  controllers: [ChatController],
  providers: [ChatService, MessagesRepository, SummaryService, AgentService],
})
export class ChatModule {}
