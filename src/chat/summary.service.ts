import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadMemoryConfig, type MemoryConfig } from '../config/memory.config.js';
import { LlmService } from '../llm/llm.service.js';
import { SUMMARY_SYSTEM_PROMPT } from '../llm/system-prompt.js';
import { MessagesRepository, type StoredMessage } from './messages.repository.js';

/**
 * SUMMARY MEMORY.
 *
 * La buffer memory da sola ha un difetto strutturale: quando un messaggio esce
 * dalla finestra, il suo contenuto è perso per sempre. L'assistente dimentica
 * come ti chiami dopo venti messaggi.
 *
 * La soluzione è comprimere invece di buttare: i messaggi vecchi vengono
 * riassunti dal modello stesso, e il riassunto viaggia in testa alla richiesta.
 * Il costo scende (un riassunto da 300 parole al posto di venti messaggi) ma i
 * fatti restano.
 *
 * Il riassunto è ROLLING: quando scatta di nuovo, il riassunto precedente
 * viene dato in pasto al modello insieme ai nuovi messaggi, così i fatti
 * antichi sopravvivono a compressioni successive invece di essere riassunti
 * "in cascata" e diluiti.
 */
@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);
  private readonly memory: MemoryConfig;
  private readonly model: string;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly llm: LlmService,
    config: ConfigService,
  ) {
    this.memory = loadMemoryConfig(config);
    // Riassumere è un compito MECCANICO: non serve il modello più capace.
    // Haiku costa 1/5 di Opus in input e fa benissimo questo lavoro.
    // È la prima ottimizzazione di costo da fare in un progetto LLM:
    // usare il modello grosso solo dove serve davvero il ragionamento.
    this.model = config.get<string>('ANTHROPIC_SUMMARY_MODEL') ?? 'claude-haiku-4-5';
  }

  /**
   * Riassume se serve. Restituisce true se ha effettivamente riassunto.
   *
   * Idempotente e sicuro da chiamare ad ogni turno: se i messaggi non
   * riassunti non superano la soglia, non fa nulla e non costa niente.
   */
  async maybeSummarize(conversationId: string): Promise<boolean> {
    const memory = await this.messages.getMemory(conversationId);
    const pending = await this.messages.findMessagesAfter(
      conversationId,
      memory.summaryThroughMessageId,
    );

    if (pending.length <= this.memory.summaryTrigger) {
      return false;
    }

    // Lasciamo gli ultimi `summaryKeepRecent` messaggi testuali: il contesto
    // immediato serve integrale, un riassunto degli ultimi due turni
    // peggiorerebbe le risposte invece di migliorarle.
    const toSummarize = pending.slice(0, pending.length - this.memory.summaryKeepRecent);
    if (toSummarize.length === 0) {
      return false;
    }

    const lastSummarized = toSummarize[toSummarize.length - 1];

    const reply = await this.llm.complete(
      [{ role: 'user', content: this.buildSummaryPrompt(memory.summary, toSummarize) }],
      {
        system: SUMMARY_SYSTEM_PROMPT,
        model: this.model,
        // Compito meccanico: effort basso, e un tetto basso di token perché
        // un riassunto lungo vanifica lo scopo (risparmiare token).
        effort: 'low',
        maxTokens: 2000,
        // Nessun caching: questo prompt è diverso ogni volta (contiene
        // messaggi nuovi), quindi pagheremmo la scrittura senza mai rileggerla.
        cache: false,
      },
    );

    await this.messages.saveSummary(conversationId, reply.text, lastSummarized.id);

    this.logger.log(
      `conversazione ${conversationId}: riassunti ${toSummarize.length} messaggi ` +
        `fino all'id ${lastSummarized.id} (${reply.inputTokens} token in / ` +
        `${reply.outputTokens} out, modello ${reply.model})`,
    );
    return true;
  }

  private buildSummaryPrompt(
    previousSummary: string | null,
    messages: StoredMessage[],
  ): string {
    const transcript = messages
      .map((message) => `[${message.role}]\n${message.content}`)
      .join('\n\n');

    if (!previousSummary) {
      return `Riassumi questa conversazione.\n\n<conversazione>\n${transcript}\n</conversazione>`;
    }

    // Riassunto rolling: il vecchio riassunto entra come materiale da fondere,
    // non come contesto da ignorare. Le istruzioni dicono esplicitamente di
    // NON perdere i fatti già presenti, altrimenti ogni compressione erode
    // un po' di informazione e dopo cinque giri non resta niente di utile.
    return `Aggiorna il riassunto della conversazione fondendoci i nuovi messaggi.
Conserva TUTTI i fatti già presenti nel riassunto esistente: non è materiale da
accorciare, è memoria da preservare. Produci un unico riassunto aggiornato.

<riassunto_esistente>
${previousSummary}
</riassunto_esistente>

<nuovi_messaggi>
${transcript}
</nuovi_messaggi>`;
  }
}
