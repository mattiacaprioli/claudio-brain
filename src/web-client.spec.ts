import { NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWebDist, SpaFallbackFilter } from './web-client.js';

/**
 * Qui si testa la parte che DECIDE, non il cablaggio: `serveWebClient` è due
 * righe di configurazione di `express.static` e testarlo significherebbe
 * testare Express. Il filtro invece contiene le due guardie che, sbagliate,
 * rompono le API in modo difficile da diagnosticare — ed è la parte che si
 * finisce per toccare aggiungendo rotte.
 */

function fakeRequest(over: Partial<Request> = {}) {
  return { method: 'GET', headers: { accept: 'text/html' }, ...over } as Request;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let sentFile: string | undefined;
  let jsonBody: unknown;
  let statusCode: number | undefined;

  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    sendFile: (file: string) => {
      sentFile = file;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json: (body: unknown) => {
      jsonBody = body;
    },
  } as unknown as Response;

  return {
    res,
    headers,
    sentFile: () => sentFile,
    jsonBody: () => jsonBody,
    statusCode: () => statusCode,
  };
}

function fakeHost(req: Request, res: Response) {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

describe('SpaFallbackFilter', () => {
  const INDEX = '/srv/web/dist/index.html';
  const filtro = new SpaFallbackFilter(INDEX);

  it('serve la pagina a una navigazione del browser', () => {
    const risposta = fakeResponse();
    const req = fakeRequest({
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });

    filtro.catch(new NotFoundException(), fakeHost(req, risposta.res));

    expect(risposta.sentFile()).toBe(INDEX);
    // Senza questo, il kiosk resta su un index che punta a bundle spariti.
    expect(risposta.headers['Cache-Control']).toBe('no-cache');
  });

  it('lascia il 404 JSON a una chiamata che non chiede HTML', () => {
    // È il caso che conta: `fetch()` senza header espliciti manda `*/*`. Se il
    // filtro rispondesse anche qui, un 404 dell'API diventerebbe una pagina
    // HTML e il client fallirebbe dentro `response.json()`, lontano dalla causa.
    const risposta = fakeResponse();
    const req = fakeRequest({ headers: { accept: '*/*' } });

    filtro.catch(new NotFoundException(), fakeHost(req, risposta.res));

    expect(risposta.sentFile()).toBeUndefined();
    expect(risposta.statusCode()).toBe(404);
    expect(risposta.jsonBody()).toMatchObject({ statusCode: 404 });
  });

  it('lascia il 404 JSON a una richiesta senza header Accept', () => {
    const risposta = fakeResponse();
    const req = fakeRequest({ headers: {} });

    filtro.catch(new NotFoundException(), fakeHost(req, risposta.res));

    expect(risposta.sentFile()).toBeUndefined();
    expect(risposta.statusCode()).toBe(404);
  });

  it('non serve la pagina ai metodi diversi da GET/HEAD', () => {
    // Una POST su un path inesistente è un errore del client, non una pagina:
    // rispondere l'index nasconderebbe un errore di rotta dietro un 200.
    const risposta = fakeResponse();
    const req = fakeRequest({ method: 'POST' });

    filtro.catch(new NotFoundException(), fakeHost(req, risposta.res));

    expect(risposta.sentFile()).toBeUndefined();
    expect(risposta.statusCode()).toBe(404);
  });

  it('conserva il messaggio originale del 404', () => {
    // Un filtro che riscrive l'errore con un messaggio generico è peggio di
    // nessun filtro: il client perde l'informazione e nessuno se ne accorge.
    const risposta = fakeResponse();
    const req = fakeRequest({ headers: { accept: '*/*' } });

    filtro.catch(
      new NotFoundException('conversazione inesistente'),
      fakeHost(req, risposta.res),
    );

    expect(risposta.jsonBody()).toMatchObject({
      message: 'conversazione inesistente',
    });
  });
});

describe('resolveWebDist', () => {
  const originale = process.env.WEB_DIST;

  afterEach(() => {
    if (originale === undefined) delete process.env.WEB_DIST;
    else process.env.WEB_DIST = originale;
  });

  it('accetta una cartella che contiene index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    process.env.WEB_DIST = dir;

    expect(resolveWebDist()).toBe(dir);
  });

  it('rifiuta una cartella senza index.html', () => {
    // Una build interrotta a metà lascia la cartella ma non l'index: servirla
    // darebbe una pagina bianca invece del messaggio "nessuna build trovata".
    process.env.WEB_DIST = mkdtempSync(join(tmpdir(), 'web-dist-vuota-'));

    expect(resolveWebDist()).toBeUndefined();
  });

  it('rifiuta un percorso inesistente', () => {
    process.env.WEB_DIST = join(tmpdir(), 'non-esiste-di-sicuro-42');

    expect(resolveWebDist()).toBeUndefined();
  });
});
