#!/usr/bin/env bash
# Apre Claudio a tutto schermo sul Raspberry Pi.
#
# Il ciclo di attesa è la ragione per cui questo è uno script e non una riga
# nell'autostart: all'accensione il desktop è pronto MOLTO prima di Docker, e
# Chromium lanciato subito trova la porta chiusa, mostra "impossibile
# raggiungere il sito" e resta lì — a tutto schermo, senza barra degli
# indirizzi per rimediare. La pagina di errore è definitiva quanto un crash.
set -euo pipefail

URL="${CLAUDIO_URL:-http://localhost:3000}"
ATTESA_MAX="${CLAUDIO_ATTESA_MAX:-120}"

echo "Attendo $URL (max ${ATTESA_MAX}s)..."
for ((i = 0; i < ATTESA_MAX; i++)); do
  if curl -sf -o /dev/null "$URL/health"; then
    echo "Claudio risponde, apro il kiosk."
    break
  fi
  sleep 1
done

# Si interroga /health e non la radice: la radice risponde anche quando manca
# la build del frontend (in quel caso l'endpoint c'è comunque), ma soprattutto
# è l'unico punto che dice "il processo è vivo" senza dipendere dai file.

# Il profilo in una cartella dedicata: al riavvio dopo un'interruzione di
# corrente — che su un robot è la norma — Chromium trova il profilo pulito e
# non mostra il pannello "ripristina le schede".
PROFILO="${CLAUDIO_PROFILO:-$HOME/.claudio-kiosk}"
rm -rf "$PROFILO/Singleton"*

exec chromium-browser \
  --kiosk \
  --app="$URL" \
  --user-data-dir="$PROFILO" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --ozone-platform-hint=auto
