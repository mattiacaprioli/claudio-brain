import Anthropic from '@anthropic-ai/sdk';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SYSTEM_PROMPT } from './system-prompt.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Modelli che accettano `thinking: { type: 'adaptive' }` e
 * `output_config.effort`.
 *
 * NON è un dettaglio di ottimizzazione: inviare quei parametri a un modello
 * che non li supporta restituisce **400 `invalid_request_error`**, non un
 * avviso. Haiku 4.5 e Sonnet 4.5 li rifiutano entrambi.
 *
 * Perché una lista di modelli AMMESSI e non di modelli esclusi: omettere i
 * due parametri funziona su qualunque modello (su Opus 5 il thinking adaptive
 * è già il default), mentre inviarli a sproposito rompe la richiesta. Quindi
 * il default sicuro è "non inviarli", e la lista dice a chi si possono
 * aggiungere — un modello nuovo e sconosciuto funzionerà comunque, al massimo
 * senza i parametri.
 *
 * I prefissi coprono anche le varianti puntate (`claude-fable-5` copre
 * `claude-fable-5-1`).
 */
const MODELS_WITH_ADAPTIVE_THINKING = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

export function supportsAdaptiveThinking(model: string): boolean {
  return MODELS_WITH_ADAPTIVE_THINKING.some((prefix) => model.startsWith(prefix));
}

/**
 * Mette un breakpoint di cache sull'ultimo blocco del messaggio `index`.
 *
 * Il marcatore va su un BLOCCO di contenuto, non sul messaggio: se il
 * contenuto è una stringa va prima convertito in un blocco `text`. È una
 * trasformazione, non una mutazione — modificare l'array originale
 * cambierebbe i messaggi anche per il chiamante.
 */
export function withCacheBreakpoint(
  messages: Anthropic.MessageParam[],
  index: number,
): Anthropic.MessageParam[] {
  if (index < 0 || index >= messages.length) return messages;

  return messages.map((message, position) => {
    if (position !== index) return message;

    const blocks: Anthropic.ContentBlockParam[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : [...message.content];

    if (blocks.length === 0) return message;

    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: 'ephemeral' },
    } as Anthropic.ContentBlockParam;

    return { ...message, content: blocks };
  });
}

export interface LlmReply {
  text: string;
  model: string;
  /** Token processati a prezzo pieno (NON il totale del prompt). */
  inputTokens: number;
  outputTokens: number;
  /** Token letti dalla cache: costano ~0.1x. */
  cacheReadTokens: number;
  /** Token scritti in cache: costano ~1.25x. */
  cacheCreationTokens: number;
}

export interface CompleteOptions {
  /** Sovrascrive il system prompt (il riassuntore ne usa uno suo). */
  system?: string;
  /** Sovrascrive il modello (per i compiti meccanici se ne usa uno più economico). */
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  /** Attiva il prompt caching automatico (breakpoint alla fine del prompt). */
  cache?: boolean;
  /**
   * Breakpoint di cache ESPLICITO: indice dell'ultimo messaggio del prefisso
   * stabile. Prevale su `cache`.
   *
   * Serve quando il prompt finisce con contenuto irripetibile — i frammenti
   * recuperati dal RAG, che cambiano ad ogni domanda. Con il caching
   * automatico il breakpoint cadrebbe *dopo* quei frammenti, e pagheremmo il
   * sovrapprezzo di scrittura (1.25x) su byte che non verranno mai riletti.
   */
  cacheUpToIndex?: number;
}

/**
 * L'unico punto del progetto che parla con Anthropic.
 *
 * IL CONCETTO CENTRALE DELLA FASE 1: l'API è STATELESS.
 * Non esiste nessuna "sessione" lato Anthropic. Ogni richiesta è indipendente e
 * deve contenere tutta la conversazione. Il modello non "ricorda" niente: la
 * memoria è una nostra tabella Postgres che rispediamo ogni volta.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;

  constructor(config: ConfigService) {
    // Fail fast all'avvio: con una key vuota l'SDK esplode solo quando arriva
    // la prima richiesta, con un errore generico. Meglio non far partire
    // l'applicazione, con un messaggio che dice cosa fare.
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY non impostata. Copia .env.example in .env e inserisci ' +
          'la key da https://console.anthropic.com (API keys).',
      );
    }

    this.client = new Anthropic({ apiKey });
    this.model = config.get<string>('ANTHROPIC_MODEL') ?? 'claude-opus-5';
    this.effort = (config.get<string>('ANTHROPIC_EFFORT') ?? 'medium') as Effort;
    this.maxTokens = Number(config.get<string>('ANTHROPIC_MAX_TOKENS') ?? 16000);
  }

  async complete(
    messages: Anthropic.MessageParam[],
    options: CompleteOptions = {},
  ): Promise<LlmReply> {
    const explicitBreakpoint = options.cacheUpToIndex !== undefined;
    const preparedMessages = explicitBreakpoint
      ? withCacheBreakpoint(messages, options.cacheUpToIndex!)
      : messages;

    const model = options.model ?? this.model;
    // I parametri di ragionamento si aggiungono solo ai modelli che li
    // accettano: altrove sono un 400, non un'opzione ignorata.
    const reasoning = supportsAdaptiveThinking(model)
      ? {
          thinking: { type: 'adaptive' as const },
          output_config: { effort: options.effort ?? this.effort },
        }
      : {};

    try {
      const response = await this.client.messages.create({
        model,

        // Tetto di sicurezza sui token GENERATI, non un obiettivo: se la
        // risposta lo supera viene troncata a metà frase (stop_reason: max_tokens).
        max_tokens: options.maxTokens ?? this.maxTokens,

        // Il system prompt è un PARAMETRO, non un messaggio con role 'system'.
        // È il motivo per cui la tabella messages ammette solo user/assistant.
        //
        // Va tenuto CONGELATO: si trova all'inizio del prompt, quindi qualunque
        // cosa dinamica qui dentro (una data, il nome utente) invaliderebbe la
        // cache di tutto ciò che viene dopo. Il contesto variabile va nei messaggi.
        system: options.system ?? SYSTEM_PROMPT,

        // Tutta la conversazione, ogni volta. Questa è la "memoria".
        messages: preparedMessages,

        // PROMPT CACHING AUTOMATICO.
        // Il breakpoint viene messo dal server sull'ultimo blocco utile (qui:
        // il messaggio appena arrivato) e avanza da solo turno dopo turno. Al
        // giro successivo tutto il prefisso — system + storico — viene letto
        // dalla cache a ~0.1x invece di essere riprocessato a prezzo pieno.
        //
        // È il pattern raccomandato per le chat multi-turno proprio perché la
        // "coda" di oggi è il "prefisso" di domani. Attenzione: il prefisso
        // deve superare i 512 token (su Opus 5) o la cache non si crea, senza
        // errori — solo `cacheCreationTokens: 0`.
        ...(options.cache && !explicitBreakpoint
          ? { cache_control: { type: 'ephemeral' as const } }
          : {}),

        // `thinking: adaptive` (il modello decide da sé quanto ragionare) e
        // `output_config.effort` (quanto spendere: low → max), ma solo sui
        // modelli che li supportano — vedi supportsAdaptiveThinking.
        //
        // NB: temperature e top_p sono stati RIMOSSI dai modelli attuali:
        // inviarli restituisce 400. `effort` è il loro sostituto, e va fissato
        // per rotta invece di variare per richiesta, perché cambiarlo
        // invalida la cache dei messaggi.
        ...reasoning,
      });

      // Un rifiuto per policy NON è un'eccezione: arriva come HTTP 200 con
      // stop_reason 'refusal'. Va controllato prima di leggere il contenuto.
      if (response.stop_reason === 'refusal') {
        throw new InternalServerErrorException(
          `Il modello ha rifiutato la richiesta: ${response.stop_details?.category ?? 'sconosciuto'}`,
        );
      }

      // `content` è un ARRAY di blocchi tipizzati (text, thinking, tool_use...),
      // non una stringa. Teniamo solo i blocchi di testo.
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      if (response.stop_reason === 'max_tokens') {
        this.logger.warn(
          `Risposta troncata: alzato il tetto di ${options.maxTokens ?? this.maxTokens} max_tokens.`,
        );
      }

      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      };
    } catch (error) {
      // Errori tipizzati dall'SDK, dal più specifico al più generico.
      // Mai fare string matching sul messaggio d'errore.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new InternalServerErrorException(
          'ANTHROPIC_API_KEY mancante o non valida.',
        );
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new ServiceUnavailableException(
          'Rate limit Anthropic raggiunto, riprova tra poco.',
        );
      }
      if (error instanceof Anthropic.APIError) {
        this.logger.error(`Anthropic API ${error.status}: ${error.message}`);
        throw new ServiceUnavailableException(
          `Errore dal provider LLM (${error.status}).`,
        );
      }
      throw error;
    }
  }
}
