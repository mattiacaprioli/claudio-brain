import type { Fragment, ToolActivity } from '../types';

/**
 * Il binario: la macchina resa visibile accanto alla trascrizione.
 *
 * È il pezzo che distingue questa interfaccia da una chat qualunque. Non è
 * decorazione: ogni riga dice una cosa che altrove resta nascosta — da quali
 * file arriva la risposta, quale metà della ricerca ibrida li ha trovati,
 * quale comando è stato eseguito e quanto è durato.
 *
 * Sta a sinistra e in mono perché è di natura diversa dal discorso: sono
 * misure, non parole. Su schermo stretto (il kiosk del Raspberry) passa sopra
 * al messaggio invece di affiancarlo.
 */
export function Rail({
  fragments,
  tools,
}: {
  fragments?: Fragment[];
  tools?: ToolActivity[];
}) {
  if ((fragments?.length ?? 0) === 0 && (tools?.length ?? 0) === 0) return null;

  return (
    <div className="rail">
      {fragments?.map((fragment) => (
        <div className="rail-row" key={`${fragment.path}${fragment.lines}`}>
          <Halves foundBy={fragment.foundBy} />
          <span className="rail-target">
            {fragment.path}
            {/* L'intervallo di righe non deve spezzarsi a fine riga: `:86-`
                seguito da `100` sulla riga dopo si legge come due numeri. */}
            {fragment.lines ? <span className="nowrap">:{fragment.lines}</span> : null}
          </span>
        </div>
      ))}

      {tools?.map((tool) => (
        <div className="rail-row rail-row-tool" key={tool.id}>
          <span className="rail-kind">esegue</span>
          <span className="rail-target">{tool.name}</span>
          {tool.durationMs === undefined ? (
            // Lo stato "in corso" è il motivo per cui esiste lo streaming:
            // senza, l'utente guarda uno schermo fermo per qualche secondo.
            <span className="rail-meta running">in corso</span>
          ) : (
            <span className={`rail-meta ${tool.isError ? 'failed' : ''}`}>
              {tool.isError ? 'errore' : `${tool.durationMs} ms`}
            </span>
          )}
          {tool.isError && tool.preview ? (
            <p className="rail-detail">{tool.preview}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Due tacche: la prima è la ricerca semantica, la seconda il full-text.
 * Piena = quella metà ha trovato il frammento.
 *
 * Perché non la parola "entrambe" in un pill: la parola costava una riga per
 * frammento e marcava il caso NORMALE, che è design al contrario — si
 * evidenziano le eccezioni. Due tacche stanno su una riga, e dicono di più:
 * non solo *quante* metà hanno trovato il risultato, ma **quali**.
 */
function Halves({ foundBy }: { foundBy: string }) {
  const semantic = foundBy === 'entrambe' || foundBy === 'semantica';
  const keyword = foundBy === 'entrambe' || foundBy === 'full-text';

  return (
    <span className="halves" title={`trovato da: ${foundBy}`}>
      <i className={semantic ? 'on' : ''} aria-hidden="true" />
      <i className={keyword ? 'on' : ''} aria-hidden="true" />
      {/* Il testo resta per chi legge con uno screen reader: le tacche sono
          una scorciatoia visiva, non l'unico canale dell'informazione. */}
      <span className="sr-only">trovato da {foundBy}</span>
    </span>
  );
}
