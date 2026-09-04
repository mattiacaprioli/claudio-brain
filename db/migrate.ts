// Runner di migration minimale: applica in ordine i file .sql di db/migrations
// che non sono ancora stati applicati, e registra quali ha applicato.
//
// Perché a mano invece di un ORM: così vedi esattamente cosa succede al DB.
// Le due regole che rendono una migration sicura sono qui dentro:
//   1) ogni file gira in una TRANSAZIONE (o passa tutto, o non passa niente);
//   2) il nome del file applicato viene registrato, quindi rilanciare è innocuo.
//
// Si lancia con: npm run db:migrate

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL non impostata (manca il file .env?)');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<{ name: string }>(
      'select name from schema_migrations',
    );
    const applied = new Set(rows.map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort(); // ordine alfabetico = ordine di applicazione: da qui il prefisso 001_

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  già applicata  ${file}`);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [
          file,
        ]);
        await client.query('commit');
        console.log(`  applicata      ${file}`);
        count += 1;
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${file} fallita: ${String(error)}`);
      }
    }

    console.log(
      count === 0 ? 'Nessuna migration da applicare.' : `${count} migration applicate.`,
    );
  } finally {
    await client.end();
  }
}

await main();
