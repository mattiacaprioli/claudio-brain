import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService, type CompleteOptions } from '../llm/llm.service.js';
import { ToolsService, type ToolExecution } from '../tools/tools.service.js';

export interface AgentRun {
  /** Testo finale destinato all'utente. */
  text: string;
  model: string;
  /** Quanti giri di modello sono serviti (1 = nessun tool usato). */
  iterations: number;
  executions: ToolExecution[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly maxIterations: number;

  constructor(
    private readonly llm: LlmService,
    private readonly tools: ToolsService,
    config: ConfigService,
  ) {
    this.maxIterations = Number(config.get<string>('AGENT_MAX_ITERATIONS') ?? 6);
  }

  /**
   * IL LOOP DELL'AGENTE.
   *
   * È tutto qui, e sono poche righe: il modello risponde, e se invece di
   * concludere chiede uno strumento (`stop_reason === 'tool_use'`), eseguiamo,
   * gli restituiamo i risultati e lo richiamiamo. Finché non conclude.
   *
   *   modello → "vorrei read_git_diff"
   *   noi     → eseguiamo, restituiamo l'output
   *   modello → "vorrei anche get_docker_status"
   *   noi     → eseguiamo, restituiamo
   *   modello → risposta finale
   *
   * La differenza fra un chatbot e un agente è questo ciclo, non il modello.
   *
   * Tre punti che vanno fatti giusti o il loop si rompe in modi confusi:
   *
   * 1. Ad ogni giro si appende `turn.content` INVARIATO. Contiene i blocchi
   *    `thinking` e `tool_use` che il modello si aspetta di ritrovare;
   *    ricostruirli dal testo li perderebbe e l'API rifiuterebbe la richiesta.
   *
   * 2. Tutti i `tool_result` vanno in UN SOLO messaggio user. Spezzarli in
   *    più messaggi insegna al modello a non chiedere più strumenti in
   *    parallelo — peggiora il comportamento in modo permanente e silenzioso.
   *
   * 3. Il loop ha un tetto. Senza, un modello che insiste su uno strumento
   *    che continua a fallire gira all'infinito bruciando token.
   */
  async run(
    messages: Anthropic.MessageParam[],
    options: CompleteOptions = {},
  ): Promise<AgentRun> {
    const conversation = [...messages];
    const executions: ToolExecution[] = [];
    const definitions = this.tools.definitions();

    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let lastText = '';
    let model = '';
    let iterations = 0;

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      iterations = iteration;

      const turn = await this.llm.converse(conversation, {
        ...options,
        tools: definitions.length > 0 ? definitions : undefined,
        // Il breakpoint di cache esplicito vale solo per la PRIMA richiesta:
        // dal secondo giro in poi la coda della conversazione è cresciuta con
        // i blocchi dei tool, e l'indice calcolato prima non punta più alla
        // fine del prefisso stabile.
        ...(iteration > 1 ? { cacheUpToIndex: undefined, cache: true } : {}),
      });

      totals.input += turn.inputTokens;
      totals.output += turn.outputTokens;
      totals.cacheRead += turn.cacheReadTokens;
      totals.cacheCreation += turn.cacheCreationTokens;
      model = turn.model;
      if (turn.text.trim().length > 0) lastText = turn.text;

      if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) {
        return {
          text: lastText,
          model,
          iterations,
          executions,
          inputTokens: totals.input,
          outputTokens: totals.output,
          cacheReadTokens: totals.cacheRead,
          cacheCreationTokens: totals.cacheCreation,
        };
      }

      // Punto 1: i blocchi del modello tornano indietro invariati.
      conversation.push({ role: 'assistant', content: turn.content });

      const results = await this.tools.executeAll(turn.toolUses);
      executions.push(...results);

      // Punto 2: tutti i risultati in un unico messaggio user.
      conversation.push({
        role: 'user',
        content: results.map((execution) => ({
          type: 'tool_result' as const,
          tool_use_id: execution.toolUseId,
          content: execution.result.content,
          // `is_error` dichiara il fallimento al modello, che può correggere
          // gli argomenti. Ometterlo lo fa credere che sia andato tutto bene.
          is_error: execution.result.isError,
        })),
      });
    }

    // Punto 3: tetto raggiunto. Non è un errore da propagare — restituiamo
    // ciò che abbiamo, dicendo che il giro è stato interrotto.
    this.logger.warn(
      `Tetto di ${this.maxIterations} iterazioni raggiunto con ` +
        `${executions.length} chiamate a strumenti.`,
    );
    return {
      text:
        lastText ||
        `Ho interrotto dopo ${this.maxIterations} passaggi di strumenti senza ` +
          'arrivare a una risposta. Prova a chiedere qualcosa di più circoscritto.',
      model,
      iterations,
      executions,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheCreationTokens: totals.cacheCreation,
    };
  }
}
