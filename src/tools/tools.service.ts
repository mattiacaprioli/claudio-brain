import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AGENT_TOOLS, type AgentTool, type ToolResult } from './tool.interface.js';

export interface ToolExecution {
  toolUseId: string;
  name: string;
  input: unknown;
  result: ToolResult;
  durationMs: number;
}

/**
 * Registro degli strumenti: unico punto che sa quali tool esistono.
 *
 * Aggiungere uno strumento = una classe + una riga nel modulo. Il resto del
 * codice (il loop dell'agente, la persistenza) non cambia mai.
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);
  private readonly byName = new Map<string, AgentTool>();

  constructor(@Inject(AGENT_TOOLS) private readonly tools: AgentTool[]) {
    for (const tool of tools) {
      this.byName.set(tool.definition.name, tool);
    }
  }

  /**
   * Le definizioni da mandare al modello, **ordinate per nome**.
   *
   * L'ordinamento non è estetica: i tool vengono resi all'inizio del prompt,
   * prima del system prompt, quindi qualunque variazione nel loro ordine
   * invalida la cache di TUTTO il resto. L'ordine di iterazione dei provider
   * di Nest non è un contratto — ordinare per nome lo rende deterministico.
   */
  definitions(): Anthropic.Tool[] {
    return [...this.tools]
      .map((tool) => tool.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get isEmpty(): boolean {
    return this.tools.length === 0;
  }

  /**
   * Esegue una richiesta di tool del modello.
   *
   * Non solleva mai: un tool inesistente o che esplode diventa un risultato
   * con `isError: true`. Il motivo è il loop dell'agente — se un'eccezione
   * risalisse, la conversazione morirebbe invece di dare al modello la
   * possibilità di correggersi.
   */
  async execute(toolUse: Anthropic.ToolUseBlock): Promise<ToolExecution> {
    const startedAt = performance.now();
    const tool = this.byName.get(toolUse.name);

    const result: ToolResult = !tool
      ? {
          content:
            `Strumento sconosciuto: "${toolUse.name}". Disponibili: ` +
            `${[...this.byName.keys()].join(', ')}.`,
          isError: true,
        }
      : await tool.execute(toolUse.input).catch((error: unknown) => ({
          content: `Errore durante l'esecuzione: ${String(error)}`,
          isError: true,
        }));

    const durationMs = Math.round(performance.now() - startedAt);

    this.logger.log(
      `${toolUse.name}(${JSON.stringify(toolUse.input)}) → ` +
        `${result.isError ? 'ERRORE' : 'ok'} in ${durationMs}ms`,
    );

    return {
      toolUseId: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
      result,
      durationMs,
    };
  }

  /**
   * Esegue in PARALLELO tutti i tool richiesti in un turno.
   *
   * Il modello può chiedere più strumenti in un solo messaggio (per esempio
   * git diff e stato Docker insieme): eseguirli in sequenza raddoppierebbe
   * l'attesa per niente.
   *
   * `allSettled` e non `all`: con `all` il primo rifiuto scarterebbe i
   * risultati degli altri — e ogni tool_use DEVE ricevere il suo tool_result,
   * altrimenti l'API rifiuta la richiesta successiva.
   */
  async executeAll(toolUses: Anthropic.ToolUseBlock[]): Promise<ToolExecution[]> {
    const settled = await Promise.allSettled(
      toolUses.map((toolUse) => this.execute(toolUse)),
    );

    return settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            toolUseId: toolUses[index].id,
            name: toolUses[index].name,
            input: toolUses[index].input,
            result: {
              content: `Errore inatteso: ${String(outcome.reason)}`,
              isError: true,
            },
            durationMs: 0,
          },
    );
  }
}
