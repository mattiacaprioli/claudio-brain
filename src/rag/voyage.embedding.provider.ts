import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { estimateTokens, type EmbeddingProvider } from './embedding.provider.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

/**
 * Voyage ha DUE limiti sovrapposti, e vanno rispettati entrambi.
 *
 * 1. Per RICHIESTA: 1000 input e 120.000 token per voyage-code-4. È il tetto
 *    sui token quello che morde — 1000 chunk da 1500 token sarebbero 1,5
 *    milioni e la richiesta verrebbe rifiutata.
 *
 * 2. Per MINUTO (rate limit), e qui c'è la sorpresa: un account **senza
 *    metodo di pagamento** è limitato a 3 richieste e 10.000 token al minuto.
 *    I 200 milioni di token gratuiti restano, ma erogati a quella portata.
 *
 * Il secondo limite ha una conseguenza che il retry NON può aggirare: una
 * singola richiesta più grande del tetto al minuto viene rifiutata per
 * sempre, qualunque attesa. Quindi la dimensione del batch deve stare sotto
 * il limite AL MINUTO, non sotto quello per richiesta.
 *
 * I default qui sotto sono quelli del piano gratuito, così l'ingestion
 * funziona senza carta (più lenta). Chi aggiunge un metodo di pagamento alza
 * i valori nel .env e l'ingestion diventa immediata.
 */
const DEFAULT_MAX_TOKENS_PER_REQUEST = 4_000; // margine ampio sotto i 10K/min
const DEFAULT_REQUESTS_PER_MINUTE = 3;
const DEFAULT_TOKENS_PER_MINUTE = 10_000;
const MAX_TEXTS_PER_REQUEST = 128;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

@Injectable()
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(VoyageEmbeddingProvider.name);
  private readonly apiKey: string | undefined;

  readonly model: string;
  readonly dimensions: number;

  private readonly maxTokensPerRequest: number;
  /** Intervallo minimo fra due richieste, derivato dal limite di richieste/minuto. */
  private readonly minIntervalMs: number;
  private readonly tokensPerMinute: number;
  /** Istante prima del quale non si può inviare la prossima richiesta. */
  private nextAllowedAt = 0;

  constructor(config: ConfigService) {
    // Qui NON facciamo fail-fast come per la key di Anthropic: il RAG è un
    // sottosistema opzionale (RAG_ENABLED), e la Fase 1 deve poter funzionare
    // con la sola key Anthropic. L'errore arriva al primo uso, esplicito.
    this.apiKey = config.get<string>('VOYAGE_API_KEY') || undefined;
    this.model = config.get<string>('EMBEDDING_MODEL') ?? 'voyage-code-4';
    this.dimensions = Number(config.get<string>('EMBEDDING_DIMENSIONS') ?? 1024);
    this.maxTokensPerRequest = Number(
      config.get<string>('EMBEDDING_MAX_TOKENS_PER_REQUEST') ??
        DEFAULT_MAX_TOKENS_PER_REQUEST,
    );
    const rpm = Number(
      config.get<string>('EMBEDDING_REQUESTS_PER_MINUTE') ??
        DEFAULT_REQUESTS_PER_MINUTE,
    );
    this.minIntervalMs = Math.ceil(60_000 / Math.max(rpm, 1));
    this.tokensPerMinute = Number(
      config.get<string>('EMBEDDING_TOKENS_PER_MINUTE') ?? DEFAULT_TOKENS_PER_MINUTE,
    );
  }

  async embed(
    texts: string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'VOYAGE_API_KEY non impostata: serve per generare gli embedding. ' +
          'Prendine una su https://dash.voyageai.com e mettila in .env.',
      );
    }
    if (texts.length === 0) return [];

    const embeddings: number[][] = [];
    for (const batch of this.buildBatches(texts)) {
      embeddings.push(...(await this.embedBatch(batch, inputType)));
    }
    return embeddings;
  }

  /**
   * Raggruppa i testi rispettando ENTRAMBI i limiti (token e conteggio).
   *
   * La stima usa `estimateTokens` (caratteri/3): vedi il commento lì sul
   * perché non caratteri/4. Serve solo a non farsi rifiutare la richiesta —
   * il conteggio esatto lo fa il server e torna in `usage.total_tokens`.
   */
  private buildBatches(texts: string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
      const estimated = estimateTokens(text);

      if (
        current.length >= MAX_TEXTS_PER_REQUEST ||
        (current.length > 0 && currentTokens + estimated > this.maxTokensPerRequest)
      ) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += estimated;
    }
    if (current.length > 0) batches.push(current);

    return batches;
  }

  /**
   * Aspetta quanto serve a rispettare ENTRAMBI i limiti al minuto.
   *
   * Prevenire è meglio che ritentare: mandare la richiesta e incassare un 429
   * spreca un tentativo e conta comunque contro la quota.
   *
   * Il tempo di attesa è il maggiore fra due vincoli:
   * - richieste/minuto → un intervallo fisso (3/min = una ogni 20s);
   * - token/minuto     → proporzionale a quanti token abbiamo appena speso
   *                      (4.000 token con un tetto di 10.000/min = 24s).
   *
   * Considerare solo il primo è l'errore che porta ai 429 a catena: tre
   * richieste da 4.000 token stanno nei limiti di richieste ma sono 12.000
   * token in un minuto, cioè oltre il tetto.
   */
  private async throttle(tokensJustQueued: number): Promise<void> {
    const waitMs = this.nextAllowedAt - Date.now();
    if (waitMs > 0) {
      this.logger.log(`Rate limit: attendo ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
    }

    const tokenIntervalMs = Math.ceil(
      (tokensJustQueued / Math.max(this.tokensPerMinute, 1)) * 60_000,
    );
    this.nextAllowedAt = Date.now() + Math.max(this.minIntervalMs, tokenIntervalMs);
  }

  private async embedBatch(
    texts: string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    const maxAttempts = 4;
    const batchTokens = texts.reduce(
      (total, text) => total + estimateTokens(text),
      0,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.throttle(batchTokens);

      const response = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          input_type: inputType,
          output_dimension: this.dimensions,
        }),
      });

      if (response.ok) {
        const payload = (await response.json()) as VoyageResponse;
        this.logger.debug(
          `${texts.length} testi · ${payload.usage.total_tokens} token · ${payload.model}`,
        );
        // I risultati vanno riordinati per `index`: l'API non garantisce
        // l'ordine, e un disallineamento assegnerebbe i vettori ai chunk
        // sbagliati — un bug che non dà errori, solo risposte assurde.
        return payload.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      }

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => '');

      if (!retryable || attempt === maxAttempts) {
        throw new ServiceUnavailableException(
          `Voyage ha risposto ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      // Su un 429 il backoff va misurato sulla FINESTRA del rate limit, non
      // in millisecondi: aspettare mezzo secondo quando il limite è di 3
      // richieste al minuto produce solo un altro 429. Se il server manda
      // `retry-after`, quello è l'unico numero autorevole.
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.minIntervalMs * attempt;

      this.logger.warn(
        `Voyage ${response.status}, ritento fra ${Math.ceil(waitMs / 1000)}s ` +
          `(tentativo ${attempt}/${maxAttempts})`,
      );
      await sleep(waitMs);
    }

    // Irraggiungibile: il ciclo esce sempre con return o throw.
    throw new ServiceUnavailableException('Voyage: tentativi esauriti.');
  }
}
