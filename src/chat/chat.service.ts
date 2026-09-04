import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadMemoryConfig, type MemoryConfig } from '../config/memory.config.js';
import { ToolCallsRepository } from '../tools/tool-calls.repository.js';
import { ToolsService } from '../tools/tools.service.js';
import { AgentService } from './agent.service.js';
import type { SearchHit } from '../rag/rag.repository.js';
import { RagService } from '../rag/rag.service.js';
import {
  MessagesRepository,
  type ConversationStats,
  type StoredMessage,
} from './messages.repository.js';
import type { EmitEvent } from './stream-events.js';
import { SummaryService } from './summary.service.js';

export interface ChatResult {
  conversationId: string;
  reply: string;
  usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Messaggi testuali mandati al modello in questo turno. */
    historyMessages: number;
    /** true se in testa alla richiesta c'era un riassunto della parte vecchia. */
    usedSummary: boolean;
  };
  /** Strumenti eseguiti in questo turno, con esito e durata. */
  toolCalls: Array<{
    name: string;
    input: unknown;
    isError: boolean;
    durationMs: number;
    output: string;
  }>;
  /** Quanti giri di modello sono serviti (1 = nessuno strumento usato). */
  iterations: number;
  /** Frammenti recuperati dal RAG: rende verificabile su cosa si è basata la risposta. */
  retrieved: Array<{
    path: string;
    lines: string | null;
    symbol: string | null;
    source: string;
    score: number;
    foundBy: 'entrambe' | 'semantica' | 'full-text';
  }>;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly memory: MemoryConfig;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly summaries: SummaryService,
    private readonly rag: RagService,
    private readonly agent: AgentService,
    private readonly tools: ToolsService,
    private readonly toolCalls: ToolCallsRepository,
    config: ConfigService,
  ) {
    this.memory = loadMemoryConfig(config);
  }

  /**
   * Il giro completo di un turno di conversazione. Sono sei passi e
   * l'ordine non è casuale — vedi i commenti.
   */
  async sendMessage(
    input: { message: string; conversationId?: string; signal?: AbortSignal },
    /**
     * Se presente, il turno viene generato in streaming e ogni passo emesso
     * come evento.
     *
     * È lo STESSO metodo, non una variante: se lo streaming avesse un suo
     * percorso separato, le due strade divergerebbero alla prima modifica —
     * una salverebbe il riassunto e l'altra no, una registrerebbe le chiamate
     * ai tool e l'altra no. Il bug più noioso da trovare.
     */
    emit?: EmitEvent,
  ): Promise<ChatResult> {
    // 1. Risolviamo la conversazione. Se il client manda un id inesistente
    //    rispondiamo 404 invece di crearne silenziosamente una nuova: un id
    //    sbagliato è un bug del client, non una nuova chat.
    const conversationId = await this.resolveConversation(input);
    // Primo evento: il client ha subito l'id per i turni successivi, anche se
    // il modello non ha ancora prodotto un solo token.
    if (emit) emit({ type: 'conversation', conversationId });

    // 2. Salviamo il messaggio utente PRIMA di chiamare il modello.
    //    Due motivi: (a) se l'LLM va in errore la domanda non va persa;
    //    (b) al passo 3 lo storico contiene già questo messaggio, quindi non
    //    dobbiamo appenderlo a mano e rischiare di duplicarlo.
    await this.messages.insertMessage({
      conversationId,
      role: 'user',
      content: input.message,
    });

    // 3. Leggiamo la memoria: il riassunto della parte vecchia + gli ultimi N
    //    messaggi non ancora riassunti. Niente stato in RAM: due istanze del
    //    server dietro un load balancer devono vedere la stessa memoria, e lo
    //    stato in RAM muore ad ogni restart.
    const memory = await this.messages.getMemory(conversationId);
    const recent = await this.messages.findRecentMessagesAfter(
      conversationId,
      memory.summaryThroughMessageId,
      this.memory.historyWindow,
    );

    // 4. RAG: cerchiamo nel codice e nella documentazione locale i frammenti
    //    utili alla domanda. Restituisce [] se il RAG è disattivato.
    const hits = await this.rag.search(input.message);
    if (emit && hits.length > 0) {
      emit({
        type: 'retrieval',
        fragments: hits.map((hit) => ({
          path: hit.path,
          lines:
            hit.start_line && hit.end_line
              ? `${hit.start_line}-${hit.end_line}`
              : null,
          symbol: hit.symbol,
          foundBy:
            hit.semantic_rank !== null && hit.keyword_rank !== null
              ? 'entrambe'
              : hit.semantic_rank !== null
                ? 'semantica'
                : 'full-text',
        })),
      });
    }

    // 5. Componiamo la richiesta e chiamiamo il modello (l'API è stateless:
    //    tutto ciò che deve "ricordare" va dentro questa richiesta).
    const { messages, cacheUpToIndex } = this.buildRequest(
      memory.summary,
      recent,
      hits,
    );
    // Il loop dell'agente: può concludersi al primo giro (nessuno strumento)
    // oppure eseguire tool e richiamare il modello finché non ha una risposta.
    const reply = await this.agent.run(
      messages,
      // Con il RAG attivo serve un breakpoint ESPLICITO invece del caching
      // automatico: il prompt finisce con i frammenti recuperati, che cambiano
      // ad ogni domanda. Vedi il commento in buildRequest.
      {
        ...(cacheUpToIndex !== null ? { cacheUpToIndex } : { cache: true }),
        signal: input.signal,
      },
      emit,
    );

    // 6. Persistiamo la risposta con il suo consumo di token.
    await this.messages.insertMessage({
      conversationId,
      role: 'assistant',
      content: reply.text,
      model: reply.model,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      cacheReadTokens: reply.cacheReadTokens,
      cacheCreationTokens: reply.cacheCreationTokens,
    });
    await this.messages.touchConversation(conversationId);

    // Registro delle esecuzioni: un agente che esegue comandi senza lasciare
    // traccia di cosa ha eseguito non è controllabile.
    await this.toolCalls.record(conversationId, reply.executions);

    this.logger.log(
      `conversazione ${conversationId} · ${recent.length} msg` +
        `${memory.summary ? ' + riassunto' : ''} · ` +
        `${reply.inputTokens} token pieni / ${reply.cacheReadTokens} da cache / ` +
        `${reply.outputTokens} out · ${reply.iterations} giri · ` +
        `${reply.executions.length} strumenti`,
    );

    // 7. Riassumiamo se serve, SENZA far aspettare l'utente.
    //    Il riassunto serve solo dal turno successivo, quindi non c'è motivo
    //    di tenere aperta la risposta HTTP per 2-3 secondi. Se fallisce,
    //    l'unica conseguenza è che si riproverà al prossimo turno: per questo
    //    logghiamo l'errore invece di propagarlo.
    void this.summaries.maybeSummarize(conversationId).catch((error: unknown) => {
      this.logger.error(
        `Sintesi fallita per ${conversationId}: ${String(error)}. Riprovo al prossimo turno.`,
      );
    });

    if (emit) {
      emit({
        type: 'done',
        usage: {
          model: reply.model,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          iterations: reply.iterations,
        },
      });
    }

    return {
      conversationId,
      reply: reply.text,
      usage: {
        model: reply.model,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheCreationTokens: reply.cacheCreationTokens,
        historyMessages: recent.length,
        usedSummary: memory.summary !== null,
      },
      iterations: reply.iterations,
      toolCalls: reply.executions.map((execution) => ({
        name: execution.name,
        input: execution.input,
        isError: execution.result.isError,
        durationMs: execution.durationMs,
        output: execution.result.content.slice(0, 500),
      })),
      retrieved: hits.map((hit) => ({
        path: hit.path,
        lines:
          hit.start_line && hit.end_line ? `${hit.start_line}-${hit.end_line}` : null,
        symbol: hit.symbol,
        source: hit.source,
        score: hit.score,
        foundBy:
          hit.semantic_rank !== null && hit.keyword_rank !== null
            ? 'entrambe'
            : hit.semantic_rank !== null
              ? 'semantica'
              : 'full-text',
      })),
    };
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    await this.assertExists(conversationId);
    return this.messages.listMessages(conversationId);
  }

  /** Inventario degli strumenti e stato dell'indice: alimenta lo stato iniziale della UI. */
  async getMeta() {
    return {
      tools: this.tools.definitions().map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
      })),
      ragEnabled: this.rag.enabled,
      index: await this.rag.stats(),
    };
  }

  /** Registro delle esecuzioni degli strumenti per una conversazione. */
  async getToolCalls(conversationId: string) {
    await this.assertExists(conversationId);
    return this.toolCalls.listByConversation(conversationId);
  }

  /** Contabilità della conversazione: token, cache, costo stimato. */
  async getStats(conversationId: string): Promise<
    ConversationStats & { estimatedCostUsd: number; cacheSavingsUsd: number }
  > {
    await this.assertExists(conversationId);
    const stats = await this.messages.getStats(conversationId);
    return { ...stats, ...estimateCost(stats) };
  }

  private async assertExists(conversationId: string): Promise<void> {
    if (!(await this.messages.conversationExists(conversationId))) {
      throw new NotFoundException(`Conversazione ${conversationId} non trovata.`);
    }
  }

  private async resolveConversation(input: {
    message: string;
    conversationId?: string;
  }): Promise<string> {
    if (input.conversationId) {
      await this.assertExists(input.conversationId);
      return input.conversationId;
    }
    // Titolo provvisorio: le prime parole del primo messaggio.
    return this.messages.createConversation(input.message.slice(0, 60));
  }

  /**
   * Adattatore memoria -> formato API.
   *
   * Il riassunto entra come PRIMO messaggio user, non nel system prompt.
   * Due ragioni:
   *
   * 1. Il system prompt sta in testa al prompt e deve restare congelato:
   *    infilarci un riassunto che cambia ad ogni sintesi invaliderebbe la
   *    cache di tutto il resto ad ogni giro.
   * 2. Il riassunto è contesto della conversazione, non istruzione
   *    all'assistente: sono due cose concettualmente diverse.
   *
   * Nota: se il riassunto c'è, i primi due messaggi sono entrambi 'user'.
   * È legale — l'API unisce i messaggi consecutivi dello stesso ruolo in un
   * unico turno.
   */
  private buildRequest(
    summary: string | null,
    recent: StoredMessage[],
    hits: SearchHit[],
  ): { messages: Anthropic.MessageParam[]; cacheUpToIndex: number | null } {
    const messages: Anthropic.MessageParam[] = [];

    if (summary) {
      messages.push({
        role: 'user',
        content:
          'Questo è il riassunto della parte precedente della nostra conversazione, ' +
          'da usare come contesto:\n\n' +
          `<riassunto_conversazione>\n${summary}\n</riassunto_conversazione>`,
      });
    }

    const context = this.rag.buildContext(hits);

    if (context.length === 0) {
      for (const message of recent) {
        messages.push({ role: message.role, content: message.content });
      }
      return { messages, cacheUpToIndex: null };
    }

    // CON IL RAG L'ORDINE CAMBIA, e per due motivi indipendenti.
    //
    // 1. QUALITÀ: i documenti vanno PRIMA della domanda. Un modello che legge
    //    prima la domanda e poi il materiale risponde peggio di uno che legge
    //    prima il materiale — quindi i frammenti si infilano tra lo storico e
    //    l'ultimo messaggio dell'utente, non in coda.
    //
    // 2. CACHE: i frammenti cambiano ad OGNI domanda, e non li salviamo nello
    //    storico. Se il breakpoint di cache cadesse dopo di loro (come fa il
    //    caching automatico), ogni turno scriverebbe in cache byte che al
    //    turno successivo non ci sono più: sovrapprezzo del 25% su contenuto
    //    mai riletto. Il breakpoint va quindi sull'ultimo messaggio del
    //    prefisso STABILE — riassunto + storico meno la domanda corrente.
    const history = recent.slice(0, -1);
    const question = recent[recent.length - 1];

    for (const message of history) {
      messages.push({ role: message.role, content: message.content });
    }

    // L'indice dell'ultimo messaggio stabile: -1 se non c'è nulla da cachare
    // (conversazione appena iniziata), e in quel caso non mettiamo marcatori.
    const cacheUpToIndex = messages.length - 1;

    messages.push({ role: 'user', content: context });
    if (question) {
      messages.push({ role: question.role, content: question.content });
    }

    return { messages, cacheUpToIndex: cacheUpToIndex >= 0 ? cacheUpToIndex : null };
  }
}

/**
 * Prezzi in USD per milione di token (fonte: docs Anthropic, possono cambiare).
 * Serve solo a rendere visibile l'ordine di grandezza, non per la fatturazione.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const DEFAULT_PRICE = PRICES['claude-opus-5'];

function estimateCost(stats: ConversationStats): {
  estimatedCostUsd: number;
  cacheSavingsUsd: number;
} {
  const price = DEFAULT_PRICE;
  const perMillion = (tokens: number, usdPerMillion: number) =>
    (tokens / 1_000_000) * usdPerMillion;

  const cost =
    perMillion(stats.inputTokens, price.input) +
    perMillion(stats.outputTokens, price.output) +
    // Le letture da cache costano ~0.1x, le scritture ~1.25x.
    perMillion(stats.cacheReadTokens, price.input * 0.1) +
    perMillion(stats.cacheCreationTokens, price.input * 1.25);

  // Quanto avremmo pagato in più se quei token fossero passati a prezzo pieno,
  // meno il sovrapprezzo di scrittura che abbiamo effettivamente pagato.
  const savings =
    perMillion(stats.cacheReadTokens, price.input * 0.9) -
    perMillion(stats.cacheCreationTokens, price.input * 0.25);

  return {
    estimatedCostUsd: Number(cost.toFixed(6)),
    cacheSavingsUsd: Number(savings.toFixed(6)),
  };
}
