-- Fase 3: registro delle esecuzioni degli strumenti.

-- Perché una tabella dedicata e non righe in `messages`: una chiamata a tool
-- non è un messaggio. Ha input strutturato, un esito, una durata e può
-- fallire — e soprattutto va ISPEZIONATA. Un agente che esegue comandi di
-- sistema senza lasciare traccia di cosa ha eseguito non è controllabile:
-- questa tabella è il registro a cui guardare quando l'agente fa qualcosa
-- di inatteso.
create table if not exists tool_calls (
  id              bigserial primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,

  -- Id del blocco tool_use assegnato dal modello: è la chiave che lega la
  -- richiesta di esecuzione al risultato restituito.
  tool_use_id     text not null,
  name            text not null,

  -- jsonb e non text: gli argomenti arrivano dal MODELLO, quindi vanno
  -- interrogabili per capire cosa ha provato a fare ("mostrami tutte le
  -- chiamate con path fuori dal progetto").
  input           jsonb not null,

  output          text,
  is_error        boolean not null default false,
  duration_ms     integer,

  created_at      timestamptz not null default now()
);

create index if not exists tool_calls_conversation_idx
  on tool_calls (conversation_id, id);
