-- Fase 1: schema per la memoria conversazionale.

create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id              bigserial primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,

  -- Solo 'user' e 'assistant': il system prompt NON è un messaggio in Claude,
  -- è un parametro separato della richiesta. Il CHECK impedisce di salvarlo qui
  -- per sbaglio e di corrompere lo storico che rimandiamo al modello.
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,

  -- Tracciamo modello e token per messaggio: è l'unico modo di sapere davvero
  -- quanto costa una conversazione (serve in Fase 1 per la Summary Memory).
  model           text,
  input_tokens    integer,
  output_tokens   integer,

  created_at      timestamptz not null default now()
);

-- La query calda è "ultimi N messaggi di questa conversazione".
-- L'indice su (conversation_id, id) la rende una index scan invece di un sort.
create index if not exists messages_conversation_id_id_idx
  on messages (conversation_id, id);
