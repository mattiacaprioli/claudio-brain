import { useRef, useState } from 'react';

/**
 * La casella di scrittura.
 *
 * Due dettagli pensati per il kiosk sul Raspberry: il pulsante è grande
 * abbastanza da premerlo col dito, e l'area di testo cresce con il contenuto
 * invece di scorrere in tre righe — su un touchscreen piccolo rileggere ciò
 * che si è scritto dentro una finestrella è penoso.
 */
export function Composer({
  onSend,
  onStop,
  busy,
}: {
  onSend: (message: string) => void;
  onStop: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = value.trim();
    if (message.length === 0 || busy) return;
    onSend(message);
    setValue('');
    if (area.current) area.current.style.height = 'auto';
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={area}
        className="composer-input"
        value={value}
        rows={1}
        placeholder="Chiedi qualcosa a Claudio"
        onChange={(event) => {
          setValue(event.target.value);
          const element = event.target;
          element.style.height = 'auto';
          element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
        }}
        onKeyDown={(event) => {
          // Invio manda, Maiusc+Invio va a capo: la convenzione che tutti si
          // aspettano da una chat.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />

      {busy ? (
        // Fermare non è una cortesia: interrompe anche la generazione lato
        // server, quindi i token non generati non li paghi.
        <button type="button" className="composer-stop" onClick={onStop}>
          Ferma
        </button>
      ) : (
        <button
          type="submit"
          className="composer-send"
          disabled={value.trim().length === 0}
        >
          Invia
        </button>
      )}
    </form>
  );
}
