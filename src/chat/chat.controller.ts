import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';

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
