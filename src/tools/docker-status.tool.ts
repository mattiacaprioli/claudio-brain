import type Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { safeExec } from './safe-exec.js';
import { truncateOutput, type AgentTool, type ToolResult } from './tool.interface.js';

interface DockerStatusInput {
  all?: boolean;
}

/**
 * Stato dei container Docker.
 *
 * Nota di design: NON accetta un nome di container come filtro. Sarebbe
 * comodo, ma un filtro passato a `docker ps --filter` è una stringa che il
 * modello compone — e l'elenco completo è corto, quindi filtrarlo lato
 * modello costa qualche token e ci risparmia un parametro non fidato.
 * Meno superficie, stessa utilità.
 */
@Injectable()
export class DockerStatusTool implements AgentTool {
  readonly definition: Anthropic.Tool = {
    name: 'get_docker_status',
    description:
      'Elenca i container Docker sulla macchina di sviluppo, con immagine, ' +
      'stato e porte. Usalo per verificare se un servizio necessario è attivo ' +
      '(per esempio il Postgres di questo progetto sulla porta 5433).',
    input_schema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description:
            'false (default) = solo container in esecuzione; true = anche quelli fermi.',
        },
      },
      additionalProperties: false,
    },
  };

  async execute(rawInput: unknown): Promise<ToolResult> {
    const input = (rawInput ?? {}) as DockerStatusInput;

    // Formato tabellare esplicito invece del default: l'output di `docker ps`
    // senza --format è pieno di spaziatura di allineamento, cioè token pagati
    // per non dire nulla.
    const args = [
      'ps',
      '--format',
      '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}',
    ];
    if (input.all === true) args.push('--all');

    const result = await safeExec('docker', args, {
      cwd: process.cwd(),
      timeoutMs: 8_000,
    });

    if (result.timedOut) {
      return { content: 'docker non ha risposto entro 8 secondi.', isError: true };
    }

    if (result.exitCode !== 0) {
      // Il caso frequente: demone spento. Va detto in chiaro, perché è una
      // cosa che l'utente può risolvere.
      const spento = /cannot connect to the docker daemon/i.test(result.stderr);
      return {
        content: spento
          ? 'Il demone Docker non è raggiungibile: probabilmente Docker non è avviato.'
          : `docker è terminato con codice ${result.exitCode}: ${result.stderr.trim()}`,
        isError: true,
      };
    }

    if (result.stdout.trim().length === 0) {
      return { content: 'Nessun container in esecuzione.', isError: false };
    }

    const header = 'NOME\tIMMAGINE\tSTATO\tPORTE';
    return {
      content: truncateOutput(`${header}\n${result.stdout.trim()}`),
      isError: false,
    };
  }
}
