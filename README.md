# Claudio

Un assistente IA che legge il mio codice, ispeziona il mio ambiente di sviluppo e comanda
l'hardware di un robot. Costruito da zero — senza LangChain, senza ORM, senza framework di
orchestrazione — per capire davvero come funzionano gli agenti IA invece di assemblarli.

**Ogni passo che l'assistente compie resta visibile**: quali file ha letto, quale metà della
ricerca ibrida li ha trovati, quale comando ha eseguito e in quanti millisecondi, quanti token
sono arrivati dalla cache. In quasi tutte le interfacce conversazionali la macchina è nascosta;
qui è il soggetto.

```
tu   Il Postgres del progetto è su? E muovi il servo a 45 gradi.

     ▪▪ roadmap.md:15-29                 Sì: claudio-brain-db (pgvector/pgvector:pg17)
     ▪▪ src/rag/rag.repository.ts:44     è up da 6 ore, healthy, su 0.0.0.0:5433.
     esegue get_docker_status  74 ms
     esegue trigger_hardware…   0 ms     Il servo non si è mosso: la chiamata è stata
                                         SIMULATA perché il Raspberry non è configurato.

                                         290 token generati · 6251 letti da cache · 2 giri
```

---

## Cosa fa

| | |
| --- | --- |
| **Memoria conversazionale** | Storico su Postgres, finestra degli ultimi N messaggi e riassunto *rolling* di ciò che esce dalla finestra |
| **Ricerca ibrida** | Vettori (`pgvector`, HNSW) **e** full-text (`tsvector`) fusi con Reciprocal Rank Fusion, su codice e documentazione locali |
| **Agente con strumenti** | Legge il `git diff`, interroga Docker, comanda servomotore e LED di un Raspberry Pi |
| **Streaming** | Server-Sent Events: il testo arriva parola per parola e gli strumenti si vedono lavorare mentre lavorano |
| **Contabilità** | Token, cache e costo stimato per conversazione, esposti dall'API e mostrati nell'interfaccia |

## Perché è costruito così

Le decisioni che contano, con l'alternativa scartata:

- **Niente LangChain.** Il RAG è SQL: `ORDER BY embedding <=> $1` con un indice HNSW e un
  `tsvector` accanto. Un framework avrebbe nascosto proprio la parte da imparare.
- **Niente ORM.** Le query sono scritte a mano, così ogni `SELECT` è leggibile e ottimizzabile.
- **Loop dell'agente manuale**, non il tool runner dell'SDK: sono trenta righe, e sono *le*
  righe che distinguono un chatbot da un agente.
- **Ricerca ibrida e non solo vettoriale.** Gli embedding sbagliano proprio dove serve di più:
  cerca `findRecentMessagesAfter` e la similarità coseno ti restituisce tre funzioni che *le
  somigliano*. Il full-text trova la stringa esatta; la fusione prende il meglio dei due.

## Architettura

```
web/           React + Vite. Client SSE, renderer Markdown senza innerHTML.
src/
  chat/        Il turno di conversazione, la memoria, il loop dell'agente.
  llm/         L'unico punto che parla con Anthropic. System prompt inclusi.
  rag/         Chunking guidato dall'AST, embeddings, ricerca ibrida.
  tools/       Strumenti dell'agente ed esecuzione sicura dei comandi.
  database/    Pool di connessioni e transazioni.
db/migrations/ Schema, in SQL semplice.
```

Il giro di un turno:

```
1. Risolvi la conversazione       id assente → nuova; id inesistente → 404
2. Salva la domanda               PRIMA di chiamare il modello
3. Leggi la memoria               riassunto + ultimi N messaggi non riassunti
4. Cerca nel RAG                  ricerca ibrida sui documenti indicizzati
5. Chiama il modello              in loop, finché chiede strumenti
6. Salva la risposta              con token e chiamate agli strumenti
7. Riassumi se serve              in background, senza far attendere
```

## Requisiti

- **Node 24** (`.nvmrc` incluso: `nvm use`). Con Node 20 lo scaffolding di NestJS 12 non parte.
- **Docker**, per Postgres.
- Una **API key Anthropic** da [console.anthropic.com](https://console.anthropic.com) — non
  l'abbonamento a Claude, che è un portafoglio separato.
- Facoltativa: una **API key Voyage** da [voyageai.com](https://dash.voyageai.com) per il RAG
  (200 milioni di token gratuiti). Senza, tutto il resto funziona con `RAG_ENABLED=false`.

## Avvio

```bash
nvm use
npm install
cp .env.example .env          # e riempi ANTHROPIC_API_KEY

npm run db:up                 # Postgres su :5433
npm run db:migrate
npm run rag:ingest            # indicizza codice e documentazione (serve VOYAGE_API_KEY)

npm run start:dev             # API su :3000
cd web && npm install && npm run dev   # interfaccia su :5173
```

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run start:dev` | API in watch mode |
| `npm test` | Test unitari: nessuna dipendenza esterna, nessun costo |
| `npm run test:db` | Test di integrazione contro Postgres reale |
| `npm run rag:ingest` | Indicizza il progetto (incrementale: salta i file invariati) |
| `npm run db:psql` | Shell psql sul database |

## API

| Metodo | Rotta | |
| --- | --- | --- |
| `POST` | `/chat` | Un turno di conversazione |
| `POST` | `/chat/stream` | Lo stesso, in streaming SSE |
| `GET` | `/chat/meta` | Strumenti disponibili e stato dell'indice |
| `GET` | `/chat/:id/messages` | Lo storico grezzo: ispeziona la memoria |
| `GET` | `/chat/:id/tools` | Cosa ha eseguito l'agente, con esito e durata |
| `GET` | `/chat/:id/stats` | Token, cache e costo stimato |

## Test

**98 unitari** e **16 di integrazione**. Due scelte che li rendono utili:

- I test unitari sostituiscono LLM e database con dei finti: girano in mezzo secondo e non
  costano un centesimo.
- I test di integrazione usano **vettori sintetici** invece di embedding veri. La distanza
  coseno la calcola Postgres e non gli importa da dove vengano i numeri, quindi tutto il SQL
  vettoriale è verificabile senza chiamare nessuna API.

Il type-check non guarda dentro le stringhe SQL: è il motivo per cui `npm run test:db` esiste.

## Sicurezza

L'agente esegue comandi sulla macchina, quindi:

- **Nessuna shell.** `execFile` con gli argomenti in un array: `x; rm -rf ~` resta una stringa,
  non diventa due comandi. Stesso principio dei parametri `$1` nelle query SQL.
- **Whitelist** dei comandi eseguibili, non blacklist.
- **Ambiente ridotto** a `PATH` e `HOME`: i comandi dell'agente non possono leggere le API key.
- **Gli argomenti dal modello sono input non fidato**: percorsi assoluti e risalite con `..`
  vengono rifiutati, e l'angolo del servo è limitato a 0-180 gradi perché è un vincolo fisico.
- Nel frontend il Markdown è reso come nodi React, mai come HTML: l'output di un modello può
  contenere `<script>`.

## Stato

Fasi 1-3 (memoria, RAG, agente) complete e verificate con API reali. Fase 4 (streaming e
interfaccia) funzionante in locale; restano il deploy e la modalità kiosk sul Raspberry.

Il percorso completo — decisioni prese, misure raccolte e trappole incontrate, comprese quelle
in cui la teoria di partenza si è rivelata invecchiata — è in **[roadmap.md](roadmap.md)**.

---

Progetto personale di apprendimento. Il codice è commentato in italiano, spiegando *perché* una
cosa è fatta così e non cosa fa la riga.
