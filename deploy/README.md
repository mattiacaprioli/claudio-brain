# Deploy: container e kiosk

Due cose diverse, che qui stanno vicine: **l'immagine** (backend + interfaccia, una sola porta)
e **il kiosk** (Chromium a tutto schermo sul Raspberry, che quell'indirizzo lo apre e basta).

> **Stato**: l'immagine è stata costruita e provata dal vero per `linux/amd64` e `linux/arm64`
> (quest'ultima in emulazione). I file del kiosk **non sono ancora stati provati su un
> Raspberry**: sono scritti, non verificati.

## L'immagine

```bash
npm run docker:build       # linux/amd64, per il PC
npm run docker:build:pi    # linux/arm64, per il Raspberry
```

Tre stage: frontend, backend, e l'immagine finale con le sole dipendenze di produzione. I primi
due girano alla velocità **nativa del builder** anche quando si costruisce per ARM — producono
JavaScript, che è testo e non ha architettura. Solo l'ultimo stage viene costruito per il
processore di destinazione, perché è quello che installa `node_modules`.

`.env` **non entra nell'immagine** (vedi `.dockerignore`): le chiavi si passano a runtime. Una
API key dentro un layer resta lì, in chiaro, per chiunque abbia l'immagine.

## Tutto in piedi con compose

```bash
npm run docker:up        # Postgres + applicazione (profilo 'app')
npm run docker:migrate   # migration dentro il container, dopo il primo avvio
npm run docker:down
```

Serve un `.env` con `ANTHROPIC_API_KEY`. Il `DATABASE_URL` viene sovrascritto da compose: dentro
il container `localhost:5433` significherebbe "il container stesso", il database si chiama
`postgres` e risponde sulla 5432.

L'applicazione sta dietro un **profilo** perché `npm run db:up` deve continuare a tirare su il
solo Postgres: in sviluppo il backend gira sull'host in watch mode, e due backend sulla stessa
porta darebbero `EADDRINUSE`.

## Il kiosk sul Raspberry

Presupposto: Raspberry Pi OS **con desktop**, Docker installato, il progetto in
`/home/pi/claudio-brain`.

```bash
# 1. l'applicazione, che riparte da sola ad ogni accensione
npm run docker:up
npm run docker:migrate      # solo la prima volta
npm run rag:ingest          # se vuoi il RAG sul corpus del progetto

# 2. il kiosk
chmod +x deploy/kiosk/claudio-kiosk.sh
mkdir -p ~/.config/autostart
cp deploy/kiosk/claudio-kiosk.desktop ~/.config/autostart/
# correggi il percorso in Exec= se il progetto non sta in /home/pi/claudio-brain
sudo apt install -y unclutter   # facoltativo: nasconde il cursore
```

Al riavvio il desktop parte, lo script aspetta che `/health` risponda e apre Chromium a tutto
schermo. L'attesa non è cortesia: all'accensione il desktop è pronto molto prima di Docker, e un
Chromium lanciato troppo presto mostra "impossibile raggiungere il sito" — a tutto schermo e
senza barra degli indirizzi per rimediare.

`restart: unless-stopped` nel compose fa il resto: dopo un'interruzione di corrente — che su un
robot è la norma — il container torna su da solo.

### Se il Pi fa solo da schermo

Basta puntare il kiosk altrove, senza Docker sul Pi:

```bash
CLAUDIO_URL=http://claudio.local:3000 deploy/kiosk/claudio-kiosk.sh
```

È la configurazione da preferire se il Pi è un modello piccolo: Postgres, l'indice HNSW e Node
sulla stessa SD card sono sostenibili su un Pi 4/5 con 4 GB, molto meno sotto.

### Note che si pagano care

- **La SD card**: Postgres scrive, e le SD si consumano. Per un uso continuativo, SSD via USB.
- **La chiave API sta sul robot.** Chi ha in mano il Pi ha in mano il `.env`. Se il robot vive in
  un posto accessibile, meglio una key dedicata con un tetto di spesa, revocabile da sola.
- **Non esporre la porta 3000 su internet** così com'è: non c'è autenticazione, e l'agente esegue
  comandi. Per mostrarlo da fuori, un tunnel temporaneo mentre lo mostri.
