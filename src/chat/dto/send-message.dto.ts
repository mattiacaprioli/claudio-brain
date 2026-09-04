import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Un DTO è il contratto d'ingresso dell'endpoint. La ValidationPipe registrata
 * in main.ts legge questi decoratori e rifiuta con 400 tutto ciò che non
 * combacia, PRIMA che il controller venga eseguito: nessun dato non validato
 * arriva mai al service (né al database, né alla bolletta di Anthropic).
 */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty({ message: 'Il messaggio non può essere vuoto.' })
  @MaxLength(20_000, { message: 'Messaggio troppo lungo (max 20.000 caratteri).' })
  message: string;

  /**
   * Assente = inizia una nuova conversazione (l'API restituisce l'id generato).
   * Presente = continua quella conversazione.
   */
  @IsOptional()
  @IsUUID('4', { message: 'conversationId deve essere un UUID.' })
  conversationId?: string;
}
