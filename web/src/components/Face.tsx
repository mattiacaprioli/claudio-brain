/**
 * La faccia di Claudio.
 *
 * Il binario (`Rail`) racconta la macchina in dettaglio, ma va letto. Questa è
 * la stessa informazione a colpo d'occhio: da dall'altra parte della stanza, o
 * sul touchscreen del Raspberry, si vede in che stato è senza leggere niente.
 *
 * Il punto che la rende strumentazione e non un vezzo: gli stati sono gli
 * EVENTI VERI dello stream SSE — `retrieval`, `tool_start`, `text` — non un
 * ciclo decorativo che gira sempre uguale. Se la faccia legge, sta davvero
 * leggendo.
 *
 * SVG inline animato in CSS, e non Lottie (servirebbe un file da After
 * Effects) né three.js (il 3D stonerebbe con l'estetica piatta da
 * strumentazione, e pesa): così è nitido a qualsiasi dimensione, costa zero
 * dipendenze e si controlla stato per stato da un foglio di stile.
 *
 * Il componente non contiene logica: rende una forma sola e appende lo stato
 * come `data-state`. Tutto il movimento sta in `styles.css`.
 */
export type FaceState =
  | 'idle'
  | 'reading'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'error';

/**
 * L'etichetta per chi legge con uno screen reader.
 *
 * Volutamente SENZA `aria-live`: la stessa informazione è già nel binario in
 * forma testuale, e annunciare ogni cambio di stato durante lo streaming
 * sarebbe un flusso continuo di interruzioni. Qui è interrogabile, non urlata.
 */
const ETICHETTE: Record<FaceState, string> = {
  idle: 'Claudio è in attesa',
  reading: 'Claudio sta leggendo i file del progetto',
  thinking: 'Claudio sta ragionando',
  working: 'Claudio sta eseguendo uno strumento',
  speaking: 'Claudio sta rispondendo',
  error: 'Claudio ha incontrato un errore',
};

export function Face({ state }: { state: FaceState }) {
  return (
    <svg
      className="face"
      data-state={state}
      viewBox="0 0 64 64"
      role="img"
      aria-label={ETICHETTE[state]}
    >
      {/* L'antenna: lo stelo, la punta, e l'anello che si espande quando c'è
          uno strumento in esecuzione — "sta lavorando fuori". */}
      <line className="face-stem" x1="32" y1="12" x2="32" y2="6" />
      <circle className="face-ping" cx="32" cy="5" r="2.5" />
      <circle className="face-tip" cx="32" cy="5" r="2.5" />

      {/* Le orecchie stanno PRIMA della testa nell'ordine di disegno: così la
          testa le copre invece di lasciarne vedere il bordo interno. */}
      <rect className="face-ear" x="4" y="26" width="6" height="13" rx="3" />
      <rect className="face-ear" x="54" y="26" width="6" height="13" rx="3" />

      <rect className="face-head" x="10" y="12" width="44" height="40" rx="14" />
      <rect className="face-screen" x="17" y="19" width="30" height="26" rx="10" />

      {/* La riga di scansione passa dietro agli occhi, che restano nitidi
          sopra. È larga 22 e si muove di ±4: entro quei limiti resta dentro
          gli angoli arrotondati dello schermo senza bisogno di un clip-path.

          Sta a 27.5, cioè SOPRA gli occhi e non in mezzo: a animazioni spente
          (`prefers-reduced-motion`) resta ferma dov'è, e una riga ferma esatta-
          mente sugli occhi non si legge come un raggio che scorre — si legge
          come una benda. */}
      <rect
        className="face-scanline"
        x="21"
        y="27.5"
        width="22"
        height="1"
        rx="0.5"
      />

      {/*
        PERCHÉ GLI OCCHI STANNO IN UN GRUPPO.

        Due animazioni sullo stesso elemento si contendono la proprietà
        `transform`: l'ultima dichiarata vince e l'altra sparisce, senza errori
        e senza che si capisca perché. Lo sguardo che scorre (translateX) va
        quindi sul gruppo, il battito di palpebre e lo strizzare (scaleY) sui
        singoli occhi. Transform annidate, nessun conflitto.
      */}
      <g className="face-eyes">
        <rect className="face-eye" x="23" y="28.5" width="5" height="7" rx="2.5" />
        <rect className="face-eye" x="36" y="28.5" width="5" height="7" rx="2.5" />
      </g>

      <rect className="face-mouth" x="28" y="37.5" width="8" height="2" rx="1" />
    </svg>
  );
}
