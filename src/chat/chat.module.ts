import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { RagModule } from '../rag/rag.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { MessagesRepository } from './messages.repository.js';
import { SummaryService } from './summary.service.js';

@Module({
  imports: [DatabaseModule, LlmModule, RagModule],
  controllers: [ChatController],
  providers: [ChatService, MessagesRepository, SummaryService],
})
export class ChatModule {}
