import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      // Elimina dal body i campi non dichiarati nel DTO...
      whitelist: true,
      // ...e va in errore se ne trova, invece di ignorarli in silenzio.
      forbidNonWhitelisted: true,
      // Trasforma il JSON grezzo in un'istanza della classe DTO.
      transform: true,
    }),
  );

  // Chiude il pool Postgres in modo pulito su SIGTERM/SIGINT
  // (senza questo, onModuleDestroy non viene chiamato).
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
