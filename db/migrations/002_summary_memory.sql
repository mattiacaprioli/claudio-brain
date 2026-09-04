-- Fase 1, parte 2: Summary Memory + tracciamento della cache.

-- Il riassunto "rolling" della parte vecchia della conversazione.
-- Vive sulla conversazione (uno per conversazione, riscritto ogni volta) e non
-- in `messages`, perché NON è un messaggio: è una compressione di N messaggi.
alter table conversations
  add column if not exists summary text,
  -- Fin dove arriva il riassunto. Tutti i messaggi con id <= questo valore
  -- sono già "dentro" il riassunto e non vanno più rimandati al modello:
  -- è questa colonna a impedire di pagare due volte lo stesso contenuto.
  add column if not exists summary_through_message_id bigint;

-- Token serviti dalla cache (costo ~0.1x) e token scritti in cache (~1.25x).
-- Senza queste due colonne non si può dimostrare che il caching funziona:
-- la bolletta cala e basta, senza spiegare perché.
alter table messages
  add column if not exists cache_read_tokens integer,
  add column if not exists cache_creation_tokens integer;
