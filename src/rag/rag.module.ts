import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { EMBEDDING_PROVIDER } from './embedding.provider.js';
import { RagRepository } from './rag.repository.js';
import { RagService } from './rag.service.js';
import { VoyageEmbeddingProvider } from './voyage.embedding.provider.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    RagRepository,
    RagService,
    // Il provider concreto è legato al token qui, in UN punto solo: passare a
    // OpenAI o a un modello locale significa cambiare questa riga.
    { provide: EMBEDDING_PROVIDER, useClass: VoyageEmbeddingProvider },
  ],
  exports: [RagService],
})
export class RagModule {}
