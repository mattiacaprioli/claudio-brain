import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

@Module({
  providers: [DatabaseService],
  // Senza `exports` gli altri moduli non possono iniettare DatabaseService:
  // in Nest un provider è privato al suo modulo finché non lo esporti.
  exports: [DatabaseService],
})
export class DatabaseModule {}
