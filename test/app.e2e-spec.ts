import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(typeof body.uptime).toBe('number');
      });
  });

  it('non occupa la radice, che deve restare alla SPA', () => {
    // Il controllo che protegge la scelta fatta in `web-client.ts`: se un
    // controller tornasse a rispondere su `/`, vincerebbe sul fallback e la
    // home mostrerebbe JSON invece della pagina. Qui l'app di test non serve
    // file statici, quindi la radice deve semplicemente non esistere.
    return request(app.getHttpServer()).get('/').expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
