import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Comandi che l'agente può eseguire. **Whitelist, non blacklist.**
 *
 * Una blacklist ("vieta rm, vieta curl…") è una battaglia persa: basta un
 * comando non previsto. Una whitelist inverte l'onere della prova — tutto è
 * vietato tranne ciò che serve, e aggiungere un comando è una decisione
 * consapevole con una riga di diff.
 */
const ALLOWED_COMMANDS = new Set(['git', 'docker']);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Esegue un comando esterno nel modo meno pericoloso possibile.
 *
 * LE QUATTRO DIFESE, in ordine di importanza:
 *
 * 1. **Nessuna shell.** `execFile` passa gli argomenti al processo come array,
 *    senza farli interpretare da bash. È la differenza fra sicurezza e
 *    speranza: con `exec('git diff ' + path)` un path come
 *    `x; rm -rf ~` esegue due comandi. Qui `;` è solo un carattere in un
 *    argomento. Non è "escaping fatto bene", è un canale diverso — la stessa
 *    ragione per cui usiamo $1/$2 nel SQL.
 *
 * 2. **Whitelist del comando.** Anche se un tool venisse scritto male, non
 *    può eseguire nulla fuori dall'elenco.
 *
 * 3. **Timeout.** Un comando che non termina bloccherebbe la richiesta HTTP
 *    e, con l'agente in loop, l'intera conversazione.
 *
 * 4. **maxBuffer.** Output illimitato = memoria illimitata. Il troncamento per
 *    il modello è un problema diverso (vedi truncateOutput): questo protegge
 *    il processo Node.
 *
 * Un exit code diverso da zero NON è un'eccezione: `git diff` senza modifiche
 * o `docker ps` con il demone spento sono informazioni per il modello, non
 * crash. Vengono restituite come risultato.
 */
export async function safeExec(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(
      `Comando non consentito: ${command}. Consentiti: ${[...ALLOWED_COMMANDS].join(', ')}.`,
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      // Ambiente ridotto al minimo: non passiamo all'agente le API key che
      // vivono in process.env. Un comando eseguito da lui non deve poterle
      // leggere né esfiltrarle.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0, timedOut: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };

    // `killed` con signal SIGTERM = ucciso dal timeout.
    const timedOut = failure.killed === true || failure.signal === 'SIGTERM';

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? String(failure.message ?? ''),
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      timedOut,
    };
  }
}
