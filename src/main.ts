import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { serveWebClient, SpaFallbackFilter } from './web-client.js';

async function bootstrap() {
  // Il tipo esplicito serve: `useStaticAssets` non esiste su `INestApplication`
  // generico, è dell'adapter Express.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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

  // I file statici prima delle rotte: un file che esiste vince sempre.
  // Il fallback, invece, è un filtro: gestisce il 404 che Nest produce quando
  // nessuna rotta ha voluto la richiesta (vedi il perché in web-client.ts).
  const webDist = serveWebClient(app);
  if (webDist) {
    app.useGlobalFilters(new SpaFallbackFilter(join(webDist, 'index.html')));
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  new Logger('Bootstrap').log(
    webDist
      ? `Interfaccia servita da ${webDist} su http://localhost:${port}`
      : 'Nessuna build in web/dist: solo API (in sviluppo il frontend sta su Vite)',
  );
}
await bootstrap();
