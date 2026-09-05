import {
  Catch,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Servire la SPA dal backend: perché, e perché non è un dettaglio di comodo.
 *
 * `web/src/api.ts` chiama `fetch('/chat/stream')` — un path RELATIVO. In
 * sviluppo il proxy di Vite lo gira sulla 3000 e sembra che funzioni ovunque;
 * in produzione, se la pagina arriva da un'origine e l'API vive su un'altra,
 * quella fetch parte verso l'origine sbagliata. Le due uscite possibili sono
 * CORS (con il preflight, i cookie, la lista di origini da tenere aggiornata)
 * oppure una sola origine. Questa è la seconda: il backend serve i file
 * statici e le API, quindi l'origine è una e il problema non nasce.
 *
 * Vale per entrambi i bersagli: il kiosk del Raspberry apre `localhost:3000`
 * e trova tutto, e un eventuale tunnel espone UNA porta invece di due.
 */

/**
 * Dove sta la build del frontend.
 *
 * `WEB_DIST` ha la precedenza perché nell'immagine Docker la build non starà
 * accanto al sorgente. Il default vale per l'esecuzione normale: questo file
 * gira compilato da `dist/web-client.js`, quindi `..` è la radice del progetto.
 *
 * Il controllo è su `index.html` e non sulla cartella: una `web/dist` che
 * esiste ma è vuota — build interrotta a metà — passerebbe il controllo sulla
 * cartella e produrrebbe una pagina bianca senza spiegazioni. Meglio dire
 * "non l'ho trovata" e restare in modalità solo-API.
 */
export function resolveWebDist(): string | undefined {
  const configured = process.env.WEB_DIST;
  const candidate = configured
    ? resolve(configured)
    : resolve(import.meta.dirname, '..', 'web', 'dist');

  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

/**
 * Il fallback della SPA: serve `index.html` alle richieste che nessuna rotta ha
 * gestito, così un ricaricamento su un path interno non finisce in 404. È il
 * pezzo che ogni host statico (Vercel compreso) configura da sé e che qui,
 * servendo noi i file, va messo a mano.
 *
 * **Perché un exception filter e non un middleware.** L'istinto dice
 * `app.use(fallback)` dopo `app.init()`, contando sull'ordine di Express: i
 * middleware registrati dopo il router vedono solo ciò che il router non ha
 * gestito. Non funziona, e il modo in cui non funziona è istruttivo: alla fine
 * dell'init Nest registra un proprio handler finale che risponde
 * `{"message":"Cannot GET /","statusCode":404}`. Quel JSON — non la pagina 404
 * di Express — è la firma del fatto che **la richiesta non arriva mai** al
 * middleware successivo, perché Nest ha già risposto. Registrarlo prima
 * dell'init lo metterebbe invece davanti a tutto, comprese le API.
 *
 * Nel modello di Nest il "non ho trovato nulla" non è la fine della catena, è
 * una `NotFoundException`. Quindi il posto giusto per dire "e allora dai la
 * pagina" è il filtro di quell'eccezione.
 *
 * Le due guardie evitano il danno classico dei catch-all: rispondere HTML anche
 * alle chiamate API, trasformando un 404 leggibile dal client in una pagina che
 * `response.json()` non sa digerire — con l'errore che sembra un bug del parser.
 *
 * - Solo GET/HEAD: una POST che non trova rotta è un errore, non una pagina.
 * - Solo se il client accetta `text/html`: la navigazione del browser lo chiede
 *   sempre, `fetch()` senza header espliciti no. È una guardia che si regge sul
 *   comportamento del CLIENT invece che su una lista di prefissi API da tenere
 *   sincronizzata con i controller — la stessa informazione scritta in due
 *   posti, cioè la prima a divergere.
 *
 * Conseguenza da conoscere: aprire *nel browser* un id inesistente su
 * `/chat/:id/messages` restituisce la pagina invece del 404 JSON. Da `curl` e
 * da `fetch` no. È il compromesso di qualunque SPA servita insieme alla sua API.
 *
 * `no-cache` sull'index non è pignoleria: gli asset di Vite hanno l'hash nel
 * nome e si possono cachare per sempre, ma l'index è l'unico file che PUNTA a
 * quegli hash. Se resta in cache, il browser continua a chiedere il bundle
 * vecchio — e su un kiosk che nessuno ricarica a mano resta indietro per sempre.
 */
@Catch(NotFoundException)
export class SpaFallbackFilter implements ExceptionFilter {
  constructor(private readonly indexFile: string) {}

  catch(exception: NotFoundException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const navigazione =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (request.headers.accept?.includes('text/html') ?? false);

    if (!navigazione) {
      // Nessuna scorciatoia: si riproduce la risposta che Nest avrebbe dato,
      // perché un filtro che "quasi" gestisce l'errore lascia la richiesta
      // appesa fino al timeout.
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(this.indexFile);
  }
}

/**
 * Registra i file statici. Restituisce la cartella servita, o `undefined` se
 * non c'è una build — in sviluppo è la norma, il frontend vive su Vite.
 *
 * Va chiamata PRIMA di `app.init()`: Express prova i middleware nell'ordine in
 * cui sono registrati, e `express.static` deve avere la prima parola sui file
 * che esistono davvero. Sulle richieste API non interferisce: non trova nessun
 * file con quel nome e passa oltre.
 */
export function serveWebClient(
  app: NestExpressApplication,
): string | undefined {
  const webDist = resolveWebDist();
  if (!webDist) return undefined;

  app.useStaticAssets(webDist, {
    // L'index NON lo serve express.static: passa dal fallback, che è l'unico
    // punto in cui si decide come consegnarlo (header di cache compresi).
    index: false,
    setHeaders(res, filePath) {
      // Tutto ciò che Vite mette in `assets/` ha l'hash del contenuto nel
      // nome: un file che cambia cambia anche nome, quindi la copia in cache
      // non può mai essere quella sbagliata. `immutable` dice al browser di
      // non chiedere nemmeno se è cambiata.
      if (filePath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  return webDist;
}
