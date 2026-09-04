import type Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { isAbsolute, normalize } from 'node:path';
import { safeExec } from './safe-exec.js';
import {
  ToolInputError,
  truncateOutput,
  type AgentTool,
  type ToolResult,
} from './tool.interface.js';

type Mode = 'unstaged' | 'staged' | 'last-commit';
const MODES: Mode[] = ['unstaged', 'staged', 'last-commit'];

interface GitDiffInput {
  mode?: Mode;
  path?: string;
}

/**
 * Legge le modifiche del repository di QUESTO progetto.
 *
 * Il repository è fisso alla radice del progetto e non configurabile dal
 * modello: se il percorso fosse un argomento, l'agente potrebbe leggere
 * qualunque repository sul disco — inclusi quelli che non hanno niente a che
 * fare con questo progetto. Un tool che espone il filesystem come parametro
 * non è uno strumento, è una falla.
 */
@Injectable()
export class GitDiffTool implements AgentTool {
  private readonly repoRoot = process.cwd();

  readonly definition: Anthropic.Tool = {
    name: 'read_git_diff',
    // La descrizione è l'unica cosa in base a cui il modello decide se usare
    // questo strumento: dice cosa fa, quando serve e cosa NON fa.
    description:
      'Legge le modifiche non ancora committate del repository di questo progetto ' +
      '(claudio-brain), oppure il contenuto dell\'ultimo commit. Usalo per spiegare ' +
      'modifiche in corso, scrivere un messaggio di commit o fare una code review. ' +
      'Non può leggere altri repository né file arbitrari.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: MODES,
          description:
            "'unstaged' (default) = modifiche non in stage; 'staged' = modifiche " +
            "in stage, pronte al commit; 'last-commit' = contenuto dell'ultimo commit.",
        },
        path: {
          type: 'string',
          description:
            'Percorso relativo opzionale per restringere il diff a un file o ' +
            'cartella, es. "src/chat". Deve stare dentro il progetto.',
        },
      },
      additionalProperties: false,
    },
  };

  async execute(rawInput: unknown): Promise<ToolResult> {
    let input: GitDiffInput;
    try {
      input = this.validate(rawInput);
    } catch (error) {
      // L'errore torna al modello, che può correggere gli argomenti e
      // riprovare. È il motivo per cui è un risultato e non un'eccezione.
      return { content: (error as Error).message, isError: true };
    }

    const result = await safeExec('git', this.buildArgs(input), {
      cwd: this.repoRoot,
      timeoutMs: 10_000,
    });

    if (result.timedOut) {
      return { content: 'git non ha risposto entro 10 secondi.', isError: true };
    }

    // "not a git repository" è la risposta più probabile su un progetto appena
    // creato: va spiegata, non mascherata da errore generico.
    if (/not a git repository|non è un repository/i.test(result.stderr)) {
      return {
        content:
          'Questo progetto non è ancora un repository Git: nessuna modifica da ' +
          'leggere. Serve un `git init` più un primo commit.',
        isError: true,
      };
    }

    if (result.exitCode !== 0) {
      return {
        content: `git è terminato con codice ${result.exitCode}: ${result.stderr.trim()}`,
        isError: true,
      };
    }

    if (result.stdout.trim().length === 0) {
      const spiegazione: Record<Mode, string> = {
        unstaged: 'Nessuna modifica non in stage.',
        staged: 'Nessuna modifica in stage.',
        'last-commit': 'Nessun commit nel repository.',
      };
      return { content: spiegazione[input.mode ?? 'unstaged'], isError: false };
    }

    // IL RIEPILOGO PRIMA DEL DETTAGLIO.
    //
    // Un diff reale supera facilmente il tetto di troncamento (quello della
    // Fase 3 era di 19.000 caratteri contro un tetto di 6.000). Restituire
    // solo il patch tagliato significa che il modello non sa nemmeno QUALI
    // file sono stati toccati oltre il punto di taglio: ha risposto
    // "potrebbero esserci altre modifiche che non vedo", che è onesto ma
    // inutile.
    //
    // Con `--stat` in testa, l'elenco completo dei file arriva sempre (costa
    // una riga per file) e il troncamento colpisce solo i dettagli. Il modello
    // sa così cosa sta guardando e cosa gli manca.
    // In modalità 'last-commit' il riepilogo è già dentro l'output (`--stat`
    // è fra gli argomenti), quindi non serve una seconda chiamata.
    const summary =
      input.mode === 'last-commit' ? '' : await this.buildSummary(input);

    return { content: summary + truncateOutput(result.stdout), isError: false };
  }

  private validate(rawInput: unknown): GitDiffInput {
    const input = (rawInput ?? {}) as Record<string, unknown>;

    if (input.mode !== undefined && !MODES.includes(input.mode as Mode)) {
      throw new ToolInputError(
        `mode non valido: "${String(input.mode)}". Valori ammessi: ${MODES.join(', ')}.`,
      );
    }

    let path: string | undefined;
    if (input.path !== undefined) {
      if (typeof input.path !== 'string') {
        throw new ToolInputError('path deve essere una stringa.');
      }
      path = this.validatePath(input.path);
    }

    return { mode: input.mode as Mode | undefined, path };
  }

  /**
   * Il percorso arriva dal modello, quindi è input non fidato.
   *
   * Due controlli, entrambi necessari: un percorso ASSOLUTO uscirebbe dal
   * progetto direttamente, e uno con `..` ci uscirebbe risalendo. Basta
   * `../../../etc/passwd` per trasformare un tool di diff in un lettore di
   * file arbitrari.
   */
  private validatePath(candidate: string): string {
    if (isAbsolute(candidate)) {
      throw new ToolInputError(
        'path deve essere relativo alla radice del progetto, non assoluto.',
      );
    }
    const normalized = normalize(candidate);
    if (normalized.startsWith('..')) {
      throw new ToolInputError('path non può uscire dalla cartella del progetto.');
    }
    return normalized;
  }

  private buildArgs(input: GitDiffInput): string[] {
    // --no-color: le sequenze ANSI sarebbero solo token sprecati per il modello.
    const base =
      input.mode === 'staged'
        ? ['diff', '--staged', '--no-color']
        : input.mode === 'last-commit'
          ? ['show', '--no-color', '--stat', '--patch', 'HEAD']
          : ['diff', '--no-color'];

    // Il separatore `--` dice a git che ciò che segue è un percorso e non
    // un'opzione: senza, un path che inizia per `-` verrebbe interpretato
    // come flag.
    return input.path ? [...base, '--', input.path] : base;
  }

  /** Riepilogo per file (`--stat`), da mettere in testa al dettaglio. */
  private async buildSummary(input: GitDiffInput): Promise<string> {
    const base =
      input.mode === 'staged'
        ? ['diff', '--staged', '--no-color', '--stat']
        : ['diff', '--no-color', '--stat'];
    const args = input.path ? [...base, '--', input.path] : base;

    const stat = await safeExec('git', args, {
      cwd: this.repoRoot,
      timeoutMs: 10_000,
    });

    // Se il riepilogo fallisce non è un problema: si perde un'informazione
    // utile, non il diff. Meglio restituire il dettaglio da solo che un errore.
    if (stat.exitCode !== 0 || stat.stdout.trim().length === 0) return '';

    return `RIEPILOGO DEI FILE MODIFICATI:\n${stat.stdout.trim()}\n\nDETTAGLIO:\n`;
  }
}
