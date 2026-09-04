import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResultRow } from 'pg';

/** Funzione di query legata a una singola connessione dentro una transazione. */
export type TransactionQuery = <T extends QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * Wrapper sottilissimo sopra il driver `pg`.
 *
 * Concetto chiave: il POOL. Aprire una connessione TCP a Postgres costa
 * ~qualche millisecondo, e Postgres crea un processo per connessione: aprirne
 * una per richiesta HTTP lo mette in ginocchio. Il pool tiene N connessioni
 * aperte e le presta. Una sola istanza per applicazione — motivo per cui è un
 * provider singleton di Nest e non un `new Pool()` sparso nel codice.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: 10,
    });
  }

  /**
   * I parametri passano SEMPRE come $1, $2... mai interpolati nella stringa SQL:
   * è il driver a inviarli separati dalla query, quindi la SQL injection è
   * impossibile per costruzione (non è "escaping fatto bene", è un altro canale).
   */
  async query<T extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const startedAt = performance.now();
    const result = await this.pool.query<T>(sql, params);
    const ms = Math.round(performance.now() - startedAt);
    this.logger.debug(`${ms}ms · ${result.rowCount} righe · ${sql.trim().split('\n')[0]}`);
    return result.rows;
  }

  /**
   * Esegue più query nella stessa TRANSAZIONE.
   *
   * Perché serve un metodo dedicato: `pool.query()` prende una connessione
   * qualsiasi dal pool ad ogni chiamata, quindi due query consecutive possono
   * finire su connessioni diverse — e `BEGIN` su una connessione non ha alcun
   * effetto sull'altra. Per una transazione bisogna tenere fissa *la stessa*
   * connessione, ed è quello che fa `pool.connect()`.
   *
   * Il `finally` con `release()` non è opzionale: una connessione non
   * rilasciata resta occupata per sempre e dopo `max` errori il pool è morto.
   */
  async withTransaction<T>(
    work: (query: TransactionQuery) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(async (sql, params = []) => {
        const queryResult = await client.query(sql, params as unknown[]);
        return queryResult.rows;
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Nest chiama questo hook allo shutdown: chiude il pool senza troncare query. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
