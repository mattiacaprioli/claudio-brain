# Roadmap di Apprendimento: Sviluppo Chatbot e Agenti IA

Costruzione passo-passo di un assistente IA per sviluppatori (**"Claudio"**, il cervello
assistente), coprendo i pilastri dello sviluppo di chatbot: memoria conversazionale, RAG,
function calling, streaming e interfaccia web/hardware.

Questo documento è sia **piano** che **diario di bordo**: ogni fase completata registra cosa
è stato costruito, quali decisioni sono state prese e perché, e cosa si è imparato — comprese
le parti della teoria di partenza che si sono rivelate invecchiate.

**Ultimo aggiornamento: 4 settembre 2026.**

---

## Stato del progetto

| Fase | Stato | Output |
| --- | --- | --- |
| **1. API LLM, System Prompt, Memoria** | ✅ **Completata e verificata** | `POST /chat` con storico su Postgres, buffer + summary memory, prompt caching |
| **2. RAG ed Embeddings** | ✅ **Completata e verificata** | Ricerca ibrida (vettori + full-text) su codice, note e doc hardware con `pgvector` |
| **3. Function Calling e Agenti** | ✅ **Completata e verificata** | Tool Use nativo per comandi di sistema, Git, Docker ed estensioni hardware |
| **4. Streaming, UI React & Hardware** | 🔧 **In corso** | Streaming SSE e UI React fatti e verificati; resta il deploy (Vercel + kiosk) |

**Verificato dal vero il 4 settembre 2026** con API key reali (Anthropic + Voyage): memoria
conversazionale, prompt caching, ingestion di 154 chunk e ricerca ibrida funzionanti.
Il dettaglio delle misure è in fondo alle Fasi 1 e 2.

Anche la **Summary Memory** è stata verificata dal vero, abbassando temporaneamente le soglie:
il riassunto è scattato, ha conservato i fatti (nome, `GPIO 18`, batteria 6V) e l'assistente ha
risposto correttamente a una domanda su un fatto **uscito dalla finestra e presente solo nel
riassunto**. La prova ha scoperto un bug che l'avrebbe resa inutilizzabile in produzione: vedi
il registro delle trappole.

---

## Setup dell'ambiente

### Requisiti (una volta sola)

**Node 24.20.0.** Non è un capriccio: con Node 20 lo scaffolding di NestJS 12 crolla con
`ERR_REQUIRE_CYCLE_MODULE` e `npm install` con `Cannot read properties of null (reading
'edgesOut')`. Dettagli nel registro delle trappole in fondo.

```bash
nvm use          # legge .nvmrc → 24.20.0
# per renderlo il default di sistema:
nvm alias default 24.20.0
```

**Docker** per Postgres. Il container usa la porta **5433** (la 5432 è occupata dal Postgres
di sistema) e l'immagine `pgvector/pgvector:pg17`, già pronta per la Fase 2.

**File `.env`.** Copia `.env.example` e riempi `ANTHROPIC_API_KEY` con una key da
[console.anthropic.com](https://console.anthropic.com). L'abbonamento di Claude Code **non** è
una API key: serve credito API separato. Senza key l'applicazione non parte (fail-fast
intenzionale, con messaggio esplicito).

### Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run db:up` / `db:down` | Avvia / ferma Postgres |
| `npm run db:migrate` | Applica le migration non ancora applicate |
| `npm run db:psql` | Shell psql sul database |
| `npm run rag:ingest` | Indicizza codice e documentazione (richiede `VOYAGE_API_KEY`) |
| `npm run start:dev` | Server in watch mode su :3000 |
| `npm test` | Test unitari (nessuna dipendenza esterna, ~0.4s) |
| `npm run test:db` | Test di integrazione (richiede `db:up`) |
| `npm run build` | Compilazione + type-check |

### Endpoint

| Metodo | Rotta | Descrizione |
| --- | --- | --- |
| `POST` | `/chat` | `{ message, conversationId? }` → risposta + `usage`. Senza `conversationId` apre una nuova conversazione |
| `GET` | `/chat/:id/messages` | Storico grezzo: ispeziona la memoria |
| `GET` | `/chat/:id/stats` | Token, cache, costo stimato |

---

## Fase 1: API LLM, System Prompt e Gestione della Memoria ✅

### Obiettivi (raggiunti)

Comprendere l'interazione con i modelli linguistici e gestire lo stato conversazionale
(*statelessness*).

### Il concetto centrale: l'API è stateless

**Non esiste nessuna sessione lato Anthropic.** Ogni richiesta HTTP è indipendente e
completamente amnesica: se al secondo messaggio mandi solo "Come mi chiamo?", il modello non ha
alcun modo di saperlo.

Quindi "memoria conversazionale" non è una feature del modello: è una tabella Postgres che
rispedisci **integralmente ad ogni turno**. Tutto il resto della fase discende da qui.

### Cosa è stato costruito

| File | Ruolo |
| --- | --- |
| `docker-compose.yml` | Postgres 17 + pgvector, porta 5433 |
| `db/migrations/001_init.sql` | `conversations`, `messages`, indice |
| `db/migrations/002_summary_memory.sql` | Colonne del riassunto e dei token di cache |
| `db/migrate.ts` | Runner migration: transazione + registro |
| `src/database/database.service.ts` | Pool di connessioni `pg` |
| `src/chat/messages.repository.ts` | Tutto il SQL dell'applicazione |
| `src/config/memory.config.ts` | Legge e **valida** i parametri della memoria |
| `src/llm/system-prompt.ts` | System prompt dell'assistente + del riassuntore |
| `src/llm/llm.service.ts` | L'unico punto che parla con Anthropic |
| `src/chat/chat.service.ts` | I 6 passi di un turno |
| `src/chat/summary.service.ts` | Riassuntore rolling |
| `src/chat/chat.controller.ts` | HTTP → service, zero logica |

Test: **18 unitari** (repository e LLM finti, nessun costo) + **6 di integrazione** contro il
Postgres vero.

### Il flusso di un turno

```
1. Risolvi la conversazione   (id assente → nuova; id inesistente → 404)
2. Salva il messaggio utente  ← PRIMA di chiamare il modello
3. Leggi la memoria           (riassunto + ultimi N messaggi non riassunti)
4. Chiama il modello          (tutto lo storico, l'API è stateless)
5. Salva la risposta          (con i token consumati)
6. Riassumi se serve          ← in background, non blocca la risposta
```

**Perché il passo 2 viene prima del 4** — due ragioni, entrambe coperte da un test:

- Se il provider LLM va in errore, la domanda non va persa (osservato dal vero: dopo una
  chiamata fallita, in `messages` c'era la riga `user` con i token vuoti).
- Al passo 3 lo storico **contiene già** il messaggio appena arrivato, quindi non va appeso a
  mano. È il bug classico: o lo dimentichi (il modello non vede la domanda) o lo appendi due
  volte.

### Buffer Memory e la matematica dei token

Rimandare tutto ogni volta ha un costo che cresce in modo non lineare. Con messaggi da ~200
token, su 20 turni il turno *k* rispedisce *2k−1* messaggi → **400 invii** ≈ 80.000 token di
input, contro 8.000 token di contenuto realmente scritto. **Paghi 10 volte il contenuto.**

`HISTORY_WINDOW=20` appiattisce la crescita: dal turno ~10 in poi mandi sempre al massimo 20
messaggi. Il prezzo è l'amnesia — ciò che esce dalla finestra è perso. Da qui la Summary Memory.

### Summary Memory: comprimere invece di buttare

```
messaggi non riassunti > SUMMARY_TRIGGER (20)
   → comprimi tutti tranne gli ultimi SUMMARY_KEEP_RECENT (8)
   → salva riassunto + confine (summary_through_message_id)
turno successivo: [riassunto] + [messaggi dopo il confine]
```

Tre decisioni:

- **Il riassunto è rolling, non a cascata.** Quando scatta di nuovo, il riassunto precedente
  entra nel prompt come materiale da *preservare*. Comprimere ripetutamente un riassunto erode
  informazione: dopo cinque giri non resta nulla di utile.
- **Restano 8 messaggi testuali**: il contesto immediato serve integrale. Riassumere gli ultimi
  due turni peggiorerebbe le risposte.
- **Il confine evita di pagare due volte** lo stesso contenuto (una volta compresso nel
  riassunto, una volta testuale nella finestra).

**Il riassunto va in `messages[0]`, non nel system prompt**, perché il system prompt deve
restare congelato per il caching, e perché un riassunto è *contesto*, non *istruzione*.

#### L'invariante che impedisce l'amnesia silenziosa

```
SUMMARY_KEEP_RECENT  <  SUMMARY_TRIGGER  <=  HISTORY_WINDOW
```

Se il trigger superasse la finestra, i messaggi non riassunti potrebbero diventare più di
quelli che la finestra spedisce: quelli in mezzo **non starebbero né nel riassunto né nella
finestra**. Sparirebbero senza errori — il bug che scopri tre settimane dopo.
`memory.config.ts` lo verifica all'avvio e rifiuta di far partire l'app.

Difesa in profondità nel SQL: `findRecentMessagesAfter` prende gli **ultimi** N, non i primi.
Se la sintesi fallisse più volte di fila, prendere i primi butterebbe via la domanda appena
arrivata.

### Prompt caching

Due numeri che hanno determinato il design:

- **Il minimo cacheable su Opus 5 è 512 token.** Il nostro system prompt da solo è più corto:
  metterci un breakpoint — la mossa istintiva — non cacherebbe nulla, *senza errori*, solo
  `cacheCreationTokens: 0`.
- Letture **0.1×**, scritture **1.25×**, break-even a **due richieste**.

Per le chat multi-turno il pattern corretto è il **caching automatico** (`cache_control`
top-level): il server piazza il breakpoint sull'ultimo blocco utile e lo fa avanzare da sé.
Il perché è elegante: **la coda di oggi è il prefisso di domani.**

Firma di un loop sano, leggibile nel campo `usage` della risposta:

| Campo | Comportamento atteso |
| --- | --- |
| `cacheReadTokens` | cresce turno dopo turno |
| `cacheCreationTokens` | resta piccolo (solo il delta) |
| `inputTokens` | solo la coda oltre il breakpoint |

Se `cacheReadTokens` resta zero su richieste consecutive c'è un invalidatore silenzioso. I tre
classici: una data nel system prompt, un ID che cambia in testa al prompt, `effort` che varia
per richiesta. Per questo il system prompt è congelato e `effort` è letto una volta dalla
configurazione. La TTL è di **5 minuti**: se l'utente risponde dopo venti, la cache è scaduta.

#### La tensione fra riassunto e cache (il punto più sottile)

Il riassunto sta in `messages[0]`: quando la sintesi scatta, il primo messaggio cambia → il
prefisso cambia da posizione zero → **tutta la cache è invalidata**, e quel turno si paga
pieno. Con trigger a 20 succede una volta ogni ~12 turni: trascurabile. Ma abbassare il trigger
a 2 "per risparmiare" distruggerebbe il caching ad ogni turno e **farebbe salire** la bolletta.

### Il modello economico per i compiti meccanici

Il riassuntore usa **Haiku 4.5** ($1/M input contro i $5 di Opus 5), `effort: 'low'`,
`max_tokens: 2000`. È la prima ottimizzazione di costo in un progetto LLM: **il modello grosso
solo dove serve ragionamento.**

La sintesi gira **dopo** la risposta, in background: serve dal turno successivo, non c'è motivo
di far attendere l'utente. Se fallisce si riprova al turno dopo.

### Ordini di grandezza

Conversazione di 40 turni, messaggi da ~200 token, input a $5/M (Opus 5):

| Strategia | Costo input stimato |
| --- | --- |
| Tutto lo storico, sempre | ~$1.60 |
| + finestra di 20 messaggi | ~$0.70 |
| + riassunto rolling | ~$0.60 |
| + prompt caching | **~$0.15** |

Il punto: **finestra e caching fanno il grosso del risparmio; il riassunto serve soprattutto a
non dimenticare.** Sono obiettivi diversi, spesso confusi.

### Correzione importante alla teoria di partenza

> `temperature` e `top_p` sono stati **rimossi** dai modelli Anthropic attuali (Opus 5,
> Sonnet 5, famiglia 4.6+). Inviarli restituisce un **errore 400**.

I parametri di controllo di oggi:

| Parametro | Cosa controlla |
| --- | --- |
| `output_config.effort` | quanto il modello ragiona e spende: `low` → `max` |
| `thinking: { type: 'adaptive' }` | il modello decide da sé quanto ragionare |
| `max_tokens` | tetto sui token **generati** (limite di sicurezza, non obiettivo) |

Il concetto "regolo la creatività con la temperature" è da archiviare per Claude. Su OpenAI
esiste ancora.

### Come provare la memoria dal vivo

```bash
# 1. Primo messaggio: restituisce conversationId
curl -s -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Mi chiamo Mattia e uso NestJS."}' | jq

# 2. Secondo turno: se risponde correttamente, la memoria funziona
curl -s -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Come mi chiamo?","conversationId":"<id>"}' | jq

# 3. Economia della conversazione
curl -s localhost:3000/chat/<id>/stats | jq
```

Per vedere la Summary Memory scattare senza fare 20 turni a mano, abbassa temporaneamente
`SUMMARY_TRIGGER=4`, `SUMMARY_KEEP_RECENT=2`, `HISTORY_WINDOW=4`, fai cinque-sei scambi e
guarda comparire `summary` con `npm run db:psql`.

### Verifica dal vero (4 settembre 2026)

Tre turni reali su `claude-opus-5` con `effort=medium`. Il caching si è comportato
esattamente come dice la documentazione:

| Turno | `inputTokens` | `cacheRead` | `cacheCreation` | Cosa dimostra |
| --- | --- | --- | --- | --- |
| 1 | 474 | 0 | **0** | Prefisso sotto i **512 token**: la cache non si crea, e nessun errore lo segnala |
| 2 | 2 | 0 | **601** | Superata la soglia → cache **scritta** |
| 3 | 2 | **601** | 71 | Cache **letta**; si scrive solo il delta |

La memoria funziona (al turno 2 ha ricordato nome e stack), e il system prompt anche: a una
domanda di cui non aveva l'informazione ha risposto *"Non lo so — non me l'hai detto"* invece
di inventare.

**Costo reale della verifica: $0.0115 per tre turni**, cioè ~0,4 centesimi per scambio — non i
~3 centesimi stimati a occhio prima di misurare. Con $5 di credito si va molto lontano.

#### Summary Memory, verificata separatamente

Con soglie abbassate (`SUMMARY_TRIGGER=4`, `SUMMARY_KEEP_RECENT=2`, `HISTORY_WINDOW=4`), RAG
spento per isolare il meccanismo e Haiku come modello di chat:

| Cosa | Esito |
| --- | --- |
| La sintesi scatta oltre la soglia | ✅ due volte, `confine = id 631` |
| Il riassunto conserva i fatti | ✅ nome, `GPIO 18`, batteria 6V |
| Il fatto compresso è ancora recuperabile | ✅ risposta *"GPIO 18, 6V"* con `usedSummary: true` e soli **3 messaggi testuali** inviati |

Il fatto era nel messaggio id 626, già dentro il riassunto: il modello non l'ha mai riletto in
forma originale. È la dimostrazione che la compressione preserva l'informazione invece di
perderla.

### Rimasto fuori dalla Fase 1

- **Few-Shot Prompting**: non usato. Da provare se il tono delle risposte non sarà giusto.
- **Chain-of-Thought**: oggi è coperto nativamente da `thinking: adaptive` — non si chiede più
  al modello di "ragionare passo passo" nel prompt.
- **Titolo della conversazione generato dal modello** (ora sono i primi 60 caratteri).
- **Token counting preventivo** (`messages.countTokens`) per stimare il costo *prima* di inviare.

---

## Fase 2: RAG ed Embeddings (senza LangChain, SQL nativo) ⬜

### Obiettivi principali

Permettere a Claudio di interrogare **basi di codice locali** (`.ts`, `.md`), note private e
**documentazione hardware del Raspberry**, mantenendo la scelta architetturale di **SQL
esplicito e zero framework di astrazione**.

### Decisioni prese (4 settembre 2026)

**Embeddings via API, non in locale.** La domanda vera non era "Voyage o OpenAI" ma "gli
embedding devono girare sul Raspberry?". No: il robot deve già stare online perché la chat
chiama l'API di Anthropic, quindi embedding locali darebbero indipendenza dalla rete solo se
*anche* l'LLM fosse locale — un altro progetto. Una chiamata di embedding da ~30ms accanto a
una chiamata LLM da qualche secondo non cambia nulla, e in cambio si evita complessità ML-ops
che distrae dalla lezione vera (chunking e retrieval). Un eventuale robot davvero offline è
materiale da **Fase 5**, con modello locale.

**Modello: `voyage-code-4`, 1024 dimensioni.**

| | |
| --- | --- |
| Perché Voyage | Anthropic non ha un modello di embedding e indica Voyage come partner; il corpus è **codice** e questo è il modello specializzato nel code retrieval |
| Modello | `voyage-code-4` — attenzione: `voyage-code-3` **non è più l'attuale** |
| Dimensioni | 1024 di default; supporta anche 256 / 512 / 2048 (Matryoshka) |
| Contesto | 32K token per chunk |
| Prezzo | $0.12 / milione di token, con 200M token gratuiti per account (la pagina prezzi elenca ancora `voyage-code-3` nel gruppo gratuito: verificare in fase di registrazione) |

Le **dimensioni variabili** sono la ragione principale della preferenza su
`text-embedding-3-small`: rigenerare lo stesso indice a 256 e a 1024 e misurare quanto peggiora
il retrieval è una leva didattica gratuita.

**La decisione è reversibile per pochi centesimi**, e questo cambia il criterio di scelta:

| Corpus | Dimensione | Token stimati | Ingestion completa |
| --- | --- | --- | --- |
| `claudio-brain` (src + db + md) | 91 KB | ~25.000 | ~$0.003 |
| `uidu-mobile/src` (289 file) | 1,4 MB | ~400.000 | ~$0.05 |

"Cambiare modello significa rigenerare tutti i vettori" non è un rischio: è un comando che
costa tre millesimi di dollaro. Quindi **si ottimizza per imparare, non per non sbagliare**.

**Ricerca ibrida: vettori + full-text nativo di Postgres.** La ricerca vettoriale pura
fallisce esattamente sugli **identificatori esatti**: chiedere *"dove sta
`findRecentMessagesAfter`?"* può restituire tre funzioni che *somigliano* a quella invece di
quella, perché gli embedding catturano il significato, non le stringhe. Postgres ha `tsvector`
integrato: zero infrastruttura nuova, coerente con il vincolo "SQL nativo", e insegna **dove
gli embedding non funzionano** — la lezione più profonda del RAG.

**Sorgenti multiple, non solo codice.** Colonna `source` per distinguere codice, note e
**documentazione hardware** (pinout GPIO, datasheet dei servo). Serve direttamente al robot
(*"come collego il servo al pin 18?"*) ed è il ponte verso la Fase 3: il tool
`trigger_hardware_action` è molto più utile se l'assistente sa com'è cablato il Pi.

### Cosa è stato costruito (4 settembre 2026)

| File | Ruolo |
| --- | --- |
| `db/migrations/003_rag.sql` | Estensione `vector`, tabella `chunks`, indici HNSW + GIN |
| `src/rag/chunking/chunk.ts` | Tipi e politica di split di sicurezza per righe |
| `src/rag/chunking/typescript.chunker.ts` | Chunking guidato dall'AST del compilatore TS |
| `src/rag/chunking/markdown.chunker.ts` | Chunking per intestazioni, con breadcrumb |
| `src/rag/embedding.provider.ts` | Interfaccia del provider + serializzazione dei vettori |
| `src/rag/voyage.embedding.provider.ts` | Implementazione Voyage con batching e retry |
| `src/rag/rag.repository.ts` | SQL della ricerca ibrida (RRF) |
| `src/rag/rag.service.ts` | Ricerca + formattazione del contesto per il prompt |
| `src/rag/ingest.ts` + `src/rag/ingest.cli.ts` | Pipeline in 3 fasi e comando `npm run rag:ingest` |

Test: **48 unitari** + **15 di integrazione** su Postgres vero. Il SQL vettoriale è
verificato con **vettori sintetici** (one-hot), quindi senza chiamare nessuna API e a costo
zero: la distanza coseno la calcola Postgres e non gli importa da dove vengano i numeri.

Sul corpus attuale (31 file) il chunking produce **116 chunk**, lunghezza media 1085 caratteri,
per una ingestion completa stimata in **$0.0038**.

### Verifica dal vero (4 settembre 2026)

Ingestion completa con `voyage-code-4`: **154 chunk** (100 di codice in 41 file, 54 di
documentazione in 2 file), zero errori 429 grazie al throttling, costo a carico dei 200M token
gratuiti.

Poi la domanda *"dove viene applicato il breakpoint di cache quando il RAG è attivo, e perché
non si usa il caching automatico?"*, che ha misurato l'effetto della correzione su
`buildKeywordQuery` (vedi registro delle trappole):

| | Frammenti | `foundBy` | Score | Chunk decisivo recuperato |
| --- | --- | --- | --- | --- |
| Prima | 4 | tutti `semantica` | ~0.016 | ❌ il modello non poteva rispondere |
| Dopo | 4 | tutti **`entrambe`** | ~0.032 | ✅ risposta corretta con `file:riga` |

È la dimostrazione pratica del perché serve la ricerca **ibrida**: con la sola metà vettoriale
il frammento che conteneva la risposta non veniva recuperato, e il modello — correttamente —
si rifiutava di rispondere.

### Competenze da acquisire

- Generazione di **embeddings vettoriali** e similarità semantica (distanza coseno).
- Strategie di **chunking per codice**: splitting guidato dall'AST (funzioni, classi,
  interfacce) invece di split rigidi per numero di caratteri.
- Operazioni vettoriali in Postgres via **`pgvector`**: operatore `<=>`, indici **HNSW**.
- **Ricerca ibrida** e fusione dei due ranking (Reciprocal Rank Fusion).
- **Prompt caching consapevole nel RAG**: i frammenti recuperati cambiano ad ogni domanda, se
  finiscono in testa al prompt invalidano la cache ogni volta — vanno dopo il prefisso stabile.

### Implementazione pratica

1. **Migration 003**: `CREATE EXTENSION vector;`, tabella `chunks` con `embedding vector(1024)`,
   colonna `tsvector` generata, indice **HNSW con `vector_cosine_ops`** e indice **GIN** per il
   full-text.
2. **Interfaccia `EmbeddingProvider`** (`embed(texts)`, `model`, `dimensions`): cambiare
   provider deve essere un file solo. Modello e dimensione vanno salvati **sulla riga** insieme
   al vettore, altrimenti mischiare vettori di due modelli produce distanze senza senso — e
   nessun errore.
3. **Chunker per TypeScript** basato sull'AST del compilatore TS, più un chunker per Markdown
   guidato dalle intestazioni.
4. **Script di ingestion** `npm run rag:ingest`: legge, spezza, calcola gli embedding in batch,
   salva vettori e metadati (path, righe, source, hash per l'ingestion incrementale).
5. **`RagService.search(query)`**: ricerca ibrida in SQL diretto, con fusione dei ranking.
6. **Integrazione nel flusso di `/chat`**: i frammenti rilevanti entrano *dopo* il prefisso
   stabile, per non distruggere il prompt caching della Fase 1.

### Vincoli tecnici da ricordare

- **La dimensione è fissa per colonna** in pgvector (serve per l'indice): confrontare due
  modelli richiede due tabelle, non due righe.
- **L'indice HNSW deve usare l'operatore giusto**: per il coseno serve `vector_cosine_ops`.
  Con l'operatore sbagliato l'indice non viene usato e la query fa un full scan **senza dirlo**.
- **Per il full-text sul codice si usa la configurazione `simple`, non `english`**: lo stemming
  inglese massacra gli identificatori.
- **Il vincolo dell'ingestion è il rate limit, non il costo.** Senza metodo di pagamento Voyage
  concede 3 richieste e 10.000 token al minuto: un'ingestion completa richiede qualche minuto.
  Aggiungere una carta (senza spendere: i 200M token gratuiti restano) alza i limiti e la rende
  immediata; in quel caso si alzano `EMBEDDING_MAX_TOKENS_PER_REQUEST`,
  `EMBEDDING_REQUESTS_PER_MINUTE` e `EMBEDDING_TOKENS_PER_MINUTE` nel `.env`.

### Già preparato in Fase 1

- Il container usa **`pgvector/pgvector:pg17`**: basta `CREATE EXTENSION vector`, nessuna
  migrazione di database.
- Il runner di migration e il pattern "tutto il SQL nel repository" sono già in piedi.
- `npm run test:db` permette di verificare le query vettoriali con vettori sintetici, **senza
  spendere un centesimo di API**.

### Domande aperte

- Quanto grandi devono essere i chunk di codice prima che il rumore superi il segnale?
- HNSW con quali parametri (`m`, `ef_construction`)?
- Quanti frammenti passare al modello: 4 sono pochi o troppi?
- Con che peso fondere ranking vettoriale e full-text?

---

## Fase 3: Function Calling e Agenti Autonomi (Tool Use nativo) ✅

### Obiettivi principali

Eseguire comandi di sistema, ispezionare il repository Git, interrogare Docker e **preparare
gli endpoint per l'hardware del Raspberry Pi**.

### Competenze da acquisire

- Definizione del parametro `tools` nell'SDK Anthropic tramite **JSON Schema**.
- Loop di esecuzione dell'agente: `stop_reason === 'tool_use'` → esecuzione locale → invio
  della risposta come `tool_result`.
- Gestione dell'**esecuzione parallela** dei tool in un unico messaggio user.
- **Sicurezza e isolamento** dei comandi di sistema eseguiti dal backend NestJS.

### Implementazione pratica

1. **`ToolsModule`** in NestJS con registratore dinamico di strumenti.
2. **Tool 1 — `read_git_diff()`**: legge le modifiche correnti, per generare spiegazioni o
   messaggi di commit.
3. **Tool 2 — `get_docker_status()`**: legge i container attivi via `docker ps`.
4. **Tool hardware — `trigger_hardware_action({ action, payload })`**: webhook o chiamata
   locale per muovere servomotori o attivare componenti, una volta spostato sul Raspberry Pi.

### Cosa è stato costruito (4 settembre 2026)

| File | Ruolo |
| --- | --- |
| `db/migrations/004_tool_calls.sql` | Registro delle esecuzioni (input `jsonb`, esito, durata) |
| `src/tools/tool.interface.ts` | Contratto `AgentTool` + troncamento output |
| `src/tools/safe-exec.ts` | Esecuzione comandi: nessuna shell, whitelist, timeout, env ridotto |
| `src/tools/git-diff.tool.ts` | `read_git_diff` con riepilogo `--stat` + validazione del path |
| `src/tools/docker-status.tool.ts` | `get_docker_status` |
| `src/tools/hardware.tool.ts` | `trigger_hardware_action` (webhook o simulazione dichiarata) |
| `src/tools/tools.service.ts` | Registro, definizioni ordinate, esecuzione parallela |
| `src/chat/agent.service.ts` | **Il loop dell'agente** |

Nuovo endpoint: `GET /chat/:id/tools` — cosa ha eseguito l'agente, con esito e durata.

**Loop manuale e non tool runner dell'SDK**, coerentemente con la scelta "zero magia": sono
poche righe e sono *le* righe che distinguono un chatbot da un agente.

### Il loop, e i tre punti che vanno fatti giusti

```
modello → "vorrei read_git_diff"
noi     → eseguiamo, restituiamo l'output
modello → "vorrei anche get_docker_status"
noi     → eseguiamo, restituiamo
modello → risposta finale
```

1. **I blocchi del modello tornano indietro INVARIATI.** Contengono `thinking` e `tool_use`
   che il modello si aspetta di ritrovare: ricostruirli dal testo li perderebbe e l'API
   rifiuterebbe la richiesta.
2. **Tutti i `tool_result` in UN SOLO messaggio user.** Spezzarli insegna al modello a non
   chiedere più strumenti in parallelo — peggiora il comportamento in modo permanente e
   silenzioso.
3. **Il loop ha un tetto** (`AGENT_MAX_ITERATIONS=6`). Senza, un modello che insiste su uno
   strumento che continua a fallire gira finché non finisce il credito.

Inoltre: il breakpoint di cache esplicito vale **solo per la prima richiesta** del loop; dal
secondo giro la coda è cresciuta con i blocchi dei tool e l'indice calcolato prima non punta
più alla fine del prefisso stabile.

### La sicurezza, che qui è il punto centrale

Un agente che esegue comandi di sistema è la parte del progetto in cui uno sbaglio non
produce una risposta scadente ma un danno. Quattro difese in `safe-exec.ts`:

1. **Nessuna shell** (`execFile`, argomenti come array). Con `exec('git diff ' + path)` un
   path come `x; rm -rf ~` esegue due comandi; con `execFile` `;` è solo un carattere. Non è
   "escaping fatto bene", è un canale diverso — la stessa ragione dei `$1/$2` nel SQL.
2. **Whitelist dei comandi** (`git`, `docker`), non blacklist: una blacklist è una battaglia
   persa, basta un comando non previsto.
3. **Timeout**, o un comando appeso blocca la richiesta e l'intera conversazione.
4. **Ambiente ridotto** a `PATH` e `HOME`: i comandi eseguiti dall'agente non devono poter
   leggere le API key che vivono in `process.env`.

A cui si aggiunge la regola sugli argomenti: **arrivano da un modello, quindi sono input non
fidato**. `read_git_diff` rifiuta path assoluti e path con `..` — senza quel controllo un tool
di diff diventa un lettore di file arbitrari (`../../../etc/passwd`).

E `trigger_hardware_action` valida `angle` fra 0 e 180 perché è un vincolo **fisico**: un
angolo fuori scala manda il servo a fondo corsa e lo fa stallare col motore che tira.

### Verifica dal vero (4 settembre 2026)

| Prova | Esito |
| --- | --- |
| Due strumenti in parallelo in un turno | ✅ `get_docker_status` + `trigger_hardware_action`, 2 giri |
| Onestà sulla simulazione | ✅ *"il servo **non** si è mosso, la chiamata è stata SIMULATA"* |
| `read_git_diff` sulle modifiche reali | ✅ riassunto accurato con `file:riga` |
| Registro delle esecuzioni | ✅ `GET /chat/:id/tools` con input, esito, durata |
| Limite fisico violato (270°) | ✅ **zero chiamate**: il modello ha letto lo schema e ha rifiutato |

L'ultima riga è la più interessante: la descrizione dello schema (`angle: 0-180`) ha fatto
lavoro *preventivo*, e il modello non ha nemmeno tentato la chiamata. La validazione lato
server resta comunque necessaria — un modello attento non è una garanzia.

Nel loop il caching ha funzionato: al secondo giro `cacheReadTokens: 6251` contro
`inputTokens: 4`.

### Domande aperte

- Come strutturare in NestJS un sistema di function calling modulare e sicuro?
- Come contenere il rischio di un tool che esegue comandi di sistema (whitelist? sandbox?)?
- Come gestire il flusso di errore quando un tool fallisce?

---

## Fase 4: Streaming, UI React (Portfolio) & Raspberry Pi Kiosk 🔧

### Obiettivi principali

Creare un'interfaccia fluida con risposte token-by-token. La UI servirà **sia come progetto da
mostrare nel portfolio, sia come interfaccia fisica** sul piccolo schermo del Raspberry Pi.

### Competenze da acquisire

- **Server-Sent Events** in NestJS tramite il decoratore `@Sse()`.
- Streaming lato SDK Anthropic con `client.messages.stream()`.
- Frontend React con **Vercel AI SDK** (`useChat`) oppure un consumatore `EventSource` custom.
- Predisposizione in **Kiosk Mode** (Chromium a tutto schermo su Raspberry Pi OS).

### Implementazione pratica

1. **Endpoint `GET /chat/:id/stream`**: streaming dei token in tempo reale.
2. **Client React (Vercel)**: UI moderna e responsive per il portfolio, con syntax highlighting
   del codice e indicatore visivo delle chiamate AI / tool in esecuzione.
3. **Build Docker multi-architettura**: `linux/amd64` per server e cloud, `linux/arm64` per il
   Raspberry Pi.

### Cosa è stato costruito (4 settembre 2026)

| File | Ruolo |
| --- | --- |
| `src/chat/stream-events.ts` | Il protocollo: unione discriminata degli eventi + frame SSE |
| `src/llm/llm.service.ts` | `streamTurn()` con `client.messages.stream()` e `AbortSignal` |
| `src/chat/agent.service.ts` | Lo stesso loop, con emissione di eventi per ogni passo |
| `src/chat/chat.controller.ts` | `POST /chat/stream` e `GET /chat/meta` |
| `web/src/api.ts` | Client SSE con buffer dei frame incompleti |
| `web/src/markdown.tsx` | Renderer Markdown senza `innerHTML` |
| `web/src/components/Rail.tsx` | La gutter: la macchina resa visibile |
| `web/src/styles.css` | Palette, tipografia, griglia, kiosk |

**`POST` e non `@Sse()`/`EventSource`.** `EventSource` sa fare solo GET senza corpo, e i
messaggi arrivano a 20.000 caratteri: non stanno in una URL. Quindi il *formato* SSE su una
POST, letta con `fetch` + ReadableStream. È anche il motivo per cui lo fanno così tutte le chat
moderne.

**Lo streaming è lo stesso metodo, non una variante.** `sendMessage(input, emit?)`: senza
`emit` si comporta esattamente come prima. Se lo streaming avesse un percorso separato, le due
strade divergerebbero alla prima modifica — una salverebbe il riassunto e l'altra no.

**L'annullamento non è cortesia formale**: se l'utente chiude la pagina, `res.on('close')`
aborta la richiesta all'API. Senza, il modello continua a generare e la risposta la paghi tutta
per un output che nessuno leggerà.

### Il design dell'interfaccia

Concetto: **non una chat, un banco di lavoro**. In ogni altra interfaccia conversazionale la
macchina è nascosta; qui è il soggetto. Il discorso scorre in una colonna e le misure — file
letti, comandi eseguiti, token — stanno appese nel margine sinistro, come le annotazioni a lato
di un manoscritto.

- **Palette**: grigio-freddo (non il crema di ogni pagina generata, non il nero con accento
  acido di ogni chat), **un solo** colore-segnale teal per tutta la strumentazione. Variante
  scura costruita, non invertita.
- **Tipografia**: IBM Plex Sans + Mono — famiglia nata per i prodotti tecnici IBM, e il mono
  qui è *contenuto* (path, token, nomi di tool), non decorazione.
- **Le due tacche** accanto a ogni frammento dicono quale metà della ricerca ibrida l'ha
  trovato. Sostituiscono un pill con la parola "entrambe", che costava una riga per frammento e
  marcava il caso NORMALE — si evidenziano le eccezioni, non la norma.
- **Movimento**: solo il testo che arriva e il puntino di "in corso". Nessun fade-in di sezione.

### Verifica dal vero (4 settembre 2026)

Sequenza di eventi osservata su una domanda che usa uno strumento:

```
conversation → retrieval (4 frammenti) → iteration 1 → tool_start
→ tool_end (74 ms) → iteration 2 → text … text → done
```

`cacheReadTokens: 6122` contro `inputTokens: 4`: la cache regge anche in streaming.

UI verificata a schermo con screenshot a 1280px e a 430px (formato kiosk), contrasti misurati
in entrambe le palette.
- Con `thinking: adaptive` il default non mostra il ragionamento: in una UI questo si vede come
  una lunga pausa prima dell'output. Se lo si vuole mostrare serve
  `thinking: { type: 'adaptive', display: 'summarized' }`.
- **Lo streaming va incrociato con il loop dell'agente della Fase 3**: un turno può richiedere
  più giri di modello, quindi la UI deve mostrare anche gli stati intermedi ("sto leggendo il
  git diff…"). I dati ci sono già — `iterations` e `toolCalls` nella risposta di `/chat` — ma
  in streaming vanno emessi come eventi mentre accadono, non alla fine.
- `AgentService.run` è il punto in cui innestare l'emissione degli eventi: oggi accumula e
  restituisce, dovrà anche notificare.

### Cosa resta

- **Deploy**: build su Vercel con `Root Directory: web`, e il backend raggiungibile.
- **Kiosk sul Raspberry**: Chromium a tutto schermo; da decidere se il Pi regge il backend o fa
  solo da display verso un backend remoto (il RAG e Postgres su un Pi sono pesanti).
- **Vercel AI SDK**: valutato dopo, ora che il protocollo lo conosciamo a fondo. Gli eventi
  `tool_start`/`tool_end` sono nostri e andrebbero mappati sul suo formato.
- Servire la build statica dal backend, per avere una sola origine e nessun proxy.

---

## Sintesi del percorso tecnologico

| Fase | Tecnologie effettive | Output |
| --- | --- | --- |
| **1. Memoria & API** ✅ | NestJS 12 (ESM), `@anthropic-ai/sdk`, Postgres 17, driver `pg` | `POST /chat` con storico persistente, buffer + summary memory, prompt caching |
| **2. RAG & Vettori** | Postgres + `pgvector`, API di embedding, SQL nativo | Ricerca semantica su codice e documenti senza LangChain |
| **3. Function Calling** | Anthropic Tool Use, JSON Schema, Docker CLI, Git, webhook | Agente capace di eseguire comandi e interagire con l'ambiente |
| **4. Streaming & UI** | React, Vercel AI SDK, NestJS SSE, Docker ARM64 | Web app per portfolio / schermo kiosk per Raspberry Pi |

---

## Registro delle decisioni

Decisioni prese confrontando i trade-off, non per default. Valgono per tutta la roadmap.

| Decisione | Alternativa scartata | Motivo |
| --- | --- | --- |
| **Provider Anthropic** | OpenAI, Ollama locale | Coerenza con gli strumenti già in uso; ottimo modello di tool use |
| **Postgres + `pgvector` nativo** | LangChain, vector DB esterni | Mantiene il controllo totale, il codice esplicito e zero magia |
| **Embeddings via API** | Modello di embedding locale sul Pi | Il robot è già online per Claude: in locale non guadagni indipendenza, paghi solo complessità |
| **`voyage-code-4` a 1024 dim** | OpenAI `text-embedding-3-small` | Specializzato sul codice; dimensioni variabili (256→2048) come leva didattica |
| **Ricerca ibrida vettori + `tsvector`** | Solo ricerca vettoriale | I vettori sbagliano proprio sugli identificatori esatti, ed è la lezione più utile del RAG |
| **SQL a mano + driver `pg`** | Prisma, TypeORM, Drizzle | Scelta didattica: vedere ogni query, nessuna astrazione inutile |
| **Node 24.20.0** | Node 20 (default di sistema) | Node 20 causa il crash di scaffolding con NestJS 12 |
| **Haiku per i riassunti** | Opus per tutto | Compito meccanico: 1/5 del costo, stessa qualità sul risultato |
| **Riassunto in `messages[0]`** | Riassunto nel system prompt | Il system prompt va congelato per il caching; il riassunto è contesto |
| **Sintesi in background** | Sintesi sincrona nel turno | Evita di far attendere l'utente durante il turno di chat |
| **UI web unificata** | UI separate web / desktop | Un'unica SPA React serve sia da portfolio online sia da display per il Raspberry |

---

## Registro delle trappole

Problemi realmente incontrati, con la diagnosi corretta. Da rileggere se ricompaiono.

**`ERR_REQUIRE_CYCLE_MODULE` creando il progetto.** Non era la soglia `>=22.12.0` del warning
`EBADENGINE`: su 22.12.0 esatto il crash era identico. È un falso positivo del rilevamento
cicli di `require(esm)`, corretto tra 22.12 e 22.21. → **Node 22.21+** (usiamo 24.20.0).

**`Cannot read properties of null (reading 'edgesOut')` durante `npm install`.** Bug di
*arborist* in npm 10.9.x sul grafo di peer dependencies di vitest 4. Non è cache corrotta:
`npm cache verify` e la rimozione di `node_modules` non cambiano nulla. → **npm 11**, incluso
in Node 24.

**Test contati 27 invece di 18.** Un file `.spec.ts` importava un helper da un altro file
`.spec.ts`, e importare un file di test **ne riesegue i `describe`**. → Fixture condivise in
`src/chat/testing/message-fixtures.ts`, senza `.spec.` nel nome.

**Chiave API vuota = errore generico a runtime.** Con `ANTHROPIC_API_KEY=''` l'SDK non solleva
un `AuthenticationError`: esplode in `buildHeaders` con un `Error` generico, prima di fare la
richiesta. → Validazione fail-fast nel costruttore di `LlmService`.

**`justify-self: start` su un blocco di testo in griglia lo fa sfondare.** Un elemento di
griglia con `justify-self: start` si dimensiona sul CONTENUTO invece di riempire la colonna:
con un `max-width: 40rem` su un viewport da 500px il testo finiva tagliato **fuori dallo
schermo**. Trovato solo misurando (`getBoundingClientRect` su tutti gli elementi), non
guardando. Cugino dello stesso problema: `min-width: auto` di default sui figli di
griglia/flex, che fa allargare la colonna a un blocco di codice lungo invece di farlo scorrere
dentro di sé. → `justify-self: stretch` sui blocchi, `min-width: 0` sui figli di griglia.

**Il grigio tenue "che sembra giusto" su fondo chiaro non passa l'accessibilità.** `#8b9ba4` sul
fondo grigio dava **2.44:1**, contro il minimo AA di 4.5 — leggibile per chi l'ha scelto, non
per chi legge. In dark mode invece passava. → Contrasti **calcolati**, non stimati: ora 6.6 e
4.6 in chiaro, 9.4 e 6.4 in scuro.

**Un renderer Markdown che produce HTML apre un buco XSS.** Il testo arriva da un LLM, che può
generare `<script>` o un `onerror` in un tag immagine: `dangerouslySetInnerHTML` su quell'output
è lo stesso errore degli argomenti dei tool non validati, ma sul browser. → Renderer che produce
nodi React (escapati per costruzione), nessun passaggio di HTML del modello.

**Il prompt caching può essere silenziosamente inattivo.** Sotto i 512 token di prefisso (su
Opus 5) la cache non si crea e non c'è nessun errore. → Verificare sempre
`usage.cacheCreationTokens`, non fidarsi della presenza del parametro.

**Il type-check non guarda dentro le stringhe SQL.** I test unitari con repository finto non
dicono nulla sulla validità delle query. → `npm run test:db` esegue il SQL vero contro Postgres.

**`temperature` su Anthropic attuale restituisce 400.** → Usare `effort` e `thinking`.

**Backtick dentro una stringa template SQL.** Un commento SQL contenente `` `pg` `` chiude il
template literal JavaScript: l'errore che ne esce è un `PARSE_ERROR` a riga sbagliata, non un
errore SQL. → Nessun backtick nei commenti dentro i template literal.

**`row_number()` arriva come STRINGA.** È `bigint`, e il driver `pg` non lo converte (un bigint
non entra in un `Number` JS in sicurezza). Lo stesso vale per `numeric`. L'interfaccia
TypeScript dichiarava `number` e mentiva: `score > altro` confrontava stringhe, in silenzio.
→ Cast espliciti in SQL (`::int`, `::float8`), e test di integrazione per accorgersene.

**L'indice HNSW non viene usato su tabelle piccole.** Con 50 righe il planner sceglie un Seq
Scan, ed è la scelta giusta. Per verificare che l'indice sia *utilizzabile* serve
`set local enable_seqscan = off` dentro una transazione. → Se l'opclass fosse sbagliata
(`vector_l2_ops` con l'operatore `<=>`), l'indice resterebbe inutilizzato anche così.

**Il chunker Markdown spezzava dentro i blocchi di codice.** Una riga `# per renderlo il
default` in un blocco ```` ```bash ```` è un commento shell, ma sembra un titolo h1. Il
documento veniva spezzato a metà esempio, separando il comando dalla spiegazione.
→ Tracciare i code fence prima di cercare intestazioni.

**Cercare la stringa iniettata è il modo SBAGLIATO di testare la shell injection.** Il primo
test di `safeExec` verificava che `git rev-parse 'HEAD; echo COMPROMESSO'` non producesse
"COMPROMESSO" in output — e falliva, perché `git rev-parse` **ristampa verbatim** l'argomento
che non riesce a risolvere. Ritrovare la stringa era in realtà la prova che era stata trattata
come *testo* e non eseguita. → Verificare l'assenza dell'**effetto**, non della stringa: con
`git ['--version; echo PWNED']`, se una shell interpretasse l'argomento in stdout comparirebbe
"git version".

**Un diff reale supera il tetto di troncamento, e il modello perde l'elenco dei file.** Il
diff della Fase 3 era di 19.000 caratteri contro un tetto di 6.000: oltre il punto di taglio il
modello non sapeva nemmeno *quali* file erano stati toccati, e ha risposto "potrebbero esserci
altre modifiche che non vedo" — onesto e inutile. → `--stat` in testa al dettaglio: l'elenco
completo dei file costa una riga per file e arriva sempre.

**`thinking: adaptive` ed `effort` NON sono supportati da tutti i modelli — e il riassuntore
usava proprio uno di quelli.** Haiku 4.5 e Sonnet 4.5 rispondono `400 invalid_request_error:
adaptive thinking is not supported on this model`. Poiché il riassuntore girava su
`claude-haiku-4-5` e i suoi errori sono catturati e loggati come *"Sintesi fallita, riprovo al
prossimo turno"*, **la Summary Memory non avrebbe mai funzionato**: ritentava in silenzio ad
ogni turno, la chat continuava a rispondere normalmente e nulla segnalava che la memoria oltre
la finestra veniva perduta per sempre. Trovato solo facendo scattare la sintesi dal vero.
→ `supportsAdaptiveThinking(model)`: una lista di modelli **ammessi**, non di esclusi, perché
omettere quei parametri funziona su qualunque modello mentre inviarli a sproposito è un 400 —
così un modello nuovo e sconosciuto funziona comunque.

**Un test che legge il DB subito dopo la risposta HTTP può leggere troppo presto.** La sintesi è
volutamente asincrona (fire-and-forget dopo la risposta), quindi il `summary` compare in
`conversations` un istante *dopo* che il client ha già ricevuto il suo JSON. Non è un bug del
codice, è un bug del test — ma sembra identico a "la sintesi non parte".

**`websearch_to_tsquery` mette i termini in AND — il bug più subdolo della Fase 2.** Una
domanda in linguaggio naturale ("dove viene applicato il breakpoint di cache quando il RAG è
attivo?") diventa una richiesta di chunk che contengano *tutte* quelle parole insieme: nessuno
le contiene, la metà full-text restituisce **zero**, e la ricerca ibrida **degenera in silenzio
in ricerca puramente vettoriale** — cioè esattamente ciò che si voleva evitare. Non si vedeva
con una query di un solo termine, cioè con tutti i test scritti fino a quel momento. Trovato
solo guardando il campo `foundBy` di una risposta vera: tutti i frammenti marcati `semantica`,
nessuno `entrambe`. → `buildKeywordQuery` mette i termini in **OR** e filtra le parole di
servizio (l'indice usa `simple`, che di proposito non rimuove le stopword). Effetto misurato
sulla stessa domanda: punteggi da ~0.016 a ~0.032, tutti i frammenti da `semantica` a
`entrambe`, e il chunk decisivo che prima non veniva recuperato è comparso.

**Node non riscrive `.js` in `.ts` negli import.** Uno script in `db/` eseguito come `.ts`
(type stripping) che importa `../src/app.module.js` cerca un file `.js` che non esiste: con
`module: nodenext` l'estensione negli import **deve** essere `.js`, ma Node risolve
letteralmente. → Gli script che importano da `src/` stanno in `src/` e si eseguono dal `dist/`
(`nest build && node dist/rag/ingest.cli.js`).

**Voyage senza metodo di pagamento: 3 richieste e 10.000 token al minuto.** I 200M token
gratuiti restano, ma erogati a quella portata. Conseguenza non ovvia: **una singola richiesta
più grande del tetto al minuto viene rifiutata per sempre**, qualunque retry — il backoff non
può aggirare un limite che la richiesta viola per costruzione. → Batch da 4.000 token e
throttling su *entrambi* i limiti (richieste/minuto **e** token/minuto): considerare solo il
primo produce 429 a catena, perché 3 richieste da 4.000 token sono 12.000 token al minuto.

**`caratteri / 4` sottostima i token del codice.** La regola "4 caratteri = 1 token" vale per la
prosa inglese; simboli, indentazione e `camelCase` si spezzano in più token. Sottostimare qui
significa costruire richieste che sfondano il limite. → `caratteri / 3`, e sovrastimare per
scelta: il costo è qualche richiesta in più, non un errore.

**Il confine del batch deve essere il rate limit, non il file.** La prima versione
dell'ingestion chiamava gli embedding una volta per file: 31 file = 31 richieste = oltre dieci
minuti, con la maggior parte delle richieste che trasportava poche centinaia di token.
→ Scansione di tutti i file senza rete, poi *una* chiamata con tutti i chunk, poi scrittura per
file riassegnando i vettori per offset.

**Chunk minuscoli come rumore nell'indice.** `const DEFAULT_PRICE = PRICES['claude-opus-5'];`
da solo è un chunk da 46 caratteri il cui vettore somiglia a tutte le costanti del progetto e
a nessuna domanda vera. Trovato solo con un dry-run su file reali, non dai test.
→ Accorpare le dichiarazioni sotto i 200 caratteri a quella successiva (e la coda orfana alla
precedente).
