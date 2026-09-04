-- Fase 2: RAG con ricerca ibrida (vettori + full-text), tutto dentro Postgres.

-- Fornita dall'immagine pgvector/pgvector:pg17 scelta in Fase 1 proprio per questo.
create extension if not exists vector;

create table if not exists chunks (
  id           bigserial primary key,

  -- 'code' | 'docs' | 'hardware': permette di filtrare o pesare le sorgenti
  -- (le domande sul cablaggio del Raspberry non devono pescare nel codice).
  source       text    not null,
  path         text    not null,
  start_line   integer,
  end_line     integer,
  -- Nome della funzione/classe/sezione da cui viene il chunk, se noto.
  symbol       text,

  content      text    not null,
  -- Hash del contenuto: permette l'ingestion incrementale (salta ciò che non
  -- è cambiato) senza ricalcolare embedding già pagati.
  content_hash text    not null,

  -- Modello e dimensione SULLA RIGA, non solo nella configurazione.
  -- Mischiare vettori di due modelli diversi non dà errori: dà solo distanze
  -- senza senso e risposte scadenti. Questa colonna rende il problema visibile.
  embedding_model text not null,

  -- La dimensione è FISSA per colonna: pgvector la richiede per costruire
  -- l'indice. 1024 = default di voyage-code-4. Cambiare modello con dimensione
  -- diversa richiede una nuova migration, non un UPDATE.
  embedding    vector(1024) not null,

  -- Metà "full-text" della ricerca ibrida, calcolata da Postgres ad ogni
  -- insert/update: una colonna generata non può andare fuori sincrono col
  -- contenuto, a differenza di un trigger scritto a mano.
  --
  -- Configurazione 'simple' e NON 'english': lo stemming inglese massacra gli
  -- identificatori ("Messages" -> "messag") e butta via le stopword, che nel
  -- codice sono parole vere. Il cast a regconfig serve perché una colonna
  -- generata accetta solo espressioni IMMUTABLE.
  content_tsv  tsvector generated always as
                 (to_tsvector('simple'::regconfig, content)) stored,

  created_at   timestamptz not null default now()
);

-- Indice vettoriale HNSW.
-- L'operatore DEVE combaciare con quello usato nella query: vector_cosine_ops
-- per la distanza coseno (<=>). Con l'operatore sbagliato l'indice viene
-- ignorato e la query fa un full scan senza segnalare nulla.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- Indice GIN per il full-text: è l'indice giusto per i tsvector.
create index if not exists chunks_tsv_idx
  on chunks using gin (content_tsv);

-- Per l'ingestion incrementale: "dammi tutti i chunk di questo file".
create index if not exists chunks_source_path_idx
  on chunks (source, path);
