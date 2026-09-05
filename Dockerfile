# syntax=docker/dockerfile:1

# Immagine di Claudio: backend + interfaccia, una sola origine, una sola porta.
#
# Due bersagli con la STESSA immagine: linux/amd64 per il PC e il cloud,
# linux/arm64 per il Raspberry Pi.
#
# Node 24 non è una preferenza: su Node 20 lo scaffolding di NestJS 12 crolla
# con ERR_REQUIRE_CYCLE_MODULE (vedi il registro delle trappole). La versione
# sta in .nvmrc e qui, e le due vanno tenute allineate a mano — un disallineamento
# si manifesta come "in locale funziona, nel container no".
ARG NODE_VERSION=24.20.0

# ---------------------------------------------------------------------------
# 1. Il frontend
#
# `--platform=$BUILDPLATFORM` è la riga che fa la differenza sui tempi, e vale
# la pena capirla: senza, costruendo per arm64 da un PC x86, Docker emula un
# ARM intero via QEMU per far girare Vite — minuti invece di secondi. Ma
# l'output di Vite sono HTML, CSS e JavaScript: file di TESTO, identici su
# qualsiasi architettura. Quindi questo stage gira alla velocità nativa del
# builder e il risultato si copia nell'immagine finale, qualunque sia il suo
# processore. Vale per il compilato, non per node_modules: quelli restano in
# questo stage e non entrano da nessuna parte.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web-build
WORKDIR /app/web

# I manifest PRIMA del codice: se non cambiano, Docker riusa il layer delle
# dipendenze e non reinstalla nulla. Copiando tutto insieme, ogni modifica a un
# componente React ributterebbe via l'installazione.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# 2. Il backend
#
# Stesso trucco: `tsc` produce JavaScript, che è testo. Si compila alla
# velocità del builder.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS server-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# 3. L'immagine finale
#
# Qui NON c'è `--platform`: questo stage viene costruito per l'architettura di
# destinazione, ed è giusto così — `npm ci` deve installare le dipendenze di
# produzione per il processore su cui gireranno.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# `production` cambia il comportamento di npm e di parecchie librerie: va messo
# prima di `npm ci`, non dopo.
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# `--omit=dev` lascia fuori il compilatore TypeScript, il CLI di Nest, vitest:
# roba che serve a COSTRUIRE e non a eseguire. Su un Pi con SD card la
# differenza si misura anche in tempo di avvio, non solo in megabyte.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist

# Le migration viaggiano con l'immagine: la versione dello schema che il codice
# si aspetta è quella che sta nella stessa immagine del codice. Tenerle fuori
# significa doverle applicare da un'altra macchina, ricordandosi quale versione.
COPY db/ ./db/

ENV WEB_DIST=/app/web/dist
ENV PORT=3000
EXPOSE 3000

# Le immagini Node hanno già un utente non-root: usarlo evita che un difetto
# nell'applicazione — o in un tool dell'agente, che qui eseguono comandi —
# diventi root dentro il container.
USER node

# La sonda di liveness usa `fetch` di Node invece di curl, che nell'immagine
# alpine non c'è: aggiungerlo significherebbe installare un pacchetto solo per
# guardarsi allo specchio.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node dist/main.js` in forma esec (senza shell): così il processo Node è il
# PID 1 e riceve DIRETTAMENTE il SIGTERM di `docker stop`. Con la forma shell il
# segnale arriverebbe a /bin/sh, Node non lo vedrebbe, e gli shutdown hooks che
# chiudono il pool Postgres non partirebbero mai — il container verrebbe ucciso
# a forza dopo dieci secondi.
CMD ["node", "dist/main.js"]
