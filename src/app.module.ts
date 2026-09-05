import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from './chat/chat.module.js';
import { HealthController } from './health.controller.js';
import { RagModule } from './rag/rag.module.js';

@Module({
  imports: [
    // Legge .env e lo rende disponibile via ConfigService.
    // isGlobal: true evita di reimportare ConfigModule in ogni modulo.
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ChatModule,
    RagModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
