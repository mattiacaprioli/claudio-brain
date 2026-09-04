import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { toSseFrame, type ChatStreamEvent } from './stream-events.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * POST /chat
   * body: { "message": "...", "conversationId": "uuid opzionale" }
   *
   * Il controller non fa altro che tradurre HTTP -> chiamata al service.
   * Zero logica qui dentro: così la logica resta testabile senza HTTP.
   */
  @Post()
  send(@Body() dto: SendMessageDto) {
    return this.chat.sendMessage({
      message: dto.message,
      conversationId: dto.conversationId,
    });
  }

  /**
   * POST /chat/stream — la stessa cosa, ma in streaming.
   *
   * PERCHÉ POST E NON `@Sse()` DI NEST: il decoratore `@Sse()` funziona su GET,
   * e `EventSource` del browser sa fare solo GET senza corpo. I nostri
   * messaggi arrivano a 20.000 caratteri e non stanno in una URL. Quindi
   * usiamo il FORMATO Server-Sent Events su una POST, e il client la legge con
   * `fetch` + ReadableStream invece di `EventSource`. È anche ciò che fanno
   * tutte le chat moderne, per la stessa ragione.
   *
   * `@Res()` disattiva la gestione automatica della risposta di Nest: qui
   * scriviamo noi sul socket, un evento per volta.
   */
  @Post('stream')
  async stream(@Body() dto: SendMessageDto, @Res() res: Response): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disattiva il buffering dei reverse proxy: senza, nginx accumula la
      // risposta e la consegna tutta insieme alla fine — lo streaming
      // funziona in locale e si "rompe" solo in produzione.
      'x-accel-buffering': 'no',
    });

    // Se l'utente chiude la pagina, abortiamo la generazione. Non è pulizia
    // formale: senza, il modello continua a generare e la risposta la paghi
    // tutta per un output che nessuno leggerà.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const send = (event: ChatStreamEvent) => {
      if (!res.writableEnded) res.write(toSseFrame(event));
    };

    try {
      await this.chat.sendMessage(
        {
          message: dto.message,
          conversationId: dto.conversationId,
          signal: controller.signal,
        },
        send,
      );
    } catch (error) {
      // Lo stream è già aperto con HTTP 200: un errore non può più diventare
      // un 500. Va consegnato come evento, o il client resta in attesa.
      if (!controller.signal.aborted) {
        send({ type: 'error', message: (error as Error).message });
      }
    } finally {
      res.end();
    }
  }

  /**
   * GET /chat/meta — cosa sa fare questo assistente, adesso.
   *
   * Serve allo stato iniziale dell'interfaccia: invece di una schermata vuota
   * con un invito generico, mostra l'inventario reale degli strumenti e quanto
   * indice c'è. Se domani si aggiunge un tool, la UI lo annuncia da sé.
   *
   * Dichiarato PRIMA delle rotte con parametro, altrimenti 'meta' verrebbe
   * interpretato come un id di conversazione.
   */
  @Get('meta')
  meta() {
    return this.chat.getMeta();
  }

  /** GET /chat/:id/messages — lo storico completo, per ispezionare la memoria. */
  @Get(':id/messages')
  messages(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.chat.getMessages(id);
  }

  /** GET /chat/:id/tools — cosa ha eseguito l'agente, con esito e durata. */
  @Get(':id/tools')
  tools(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.chat.getToolCalls(id);
  }

  /**
   * GET /chat/:id/stats — token consumati, risparmio della cache, costo stimato.
   * Serve a rendere visibile l'economia della conversazione: senza numeri,
   * "ottimizzare i token" resta un discorso astratto.
   */
  @Get(':id/stats')
  stats(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.chat.getStats(id);
  }
}
