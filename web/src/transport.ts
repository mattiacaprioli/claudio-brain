import { fetchMeta, streamChat } from './api';
import { domandeRegistrate, replayChat, replayMeta } from './demo/replay';

/**
 * L'unico punto dell'applicazione che sa se stiamo parlando con un backend
 * vero o riproducendo una registrazione.
 *
 * Tenerlo qui — e non dentro i componenti — è la ragione per cui la modalità
 * demo non ha sporcato la UI: `App.tsx` importa `streamChat` e `fetchMeta` da
 * questo modulo e non contiene nessun `if (demo)` nel flusso. Le due
 * implementazioni hanno la stessa firma proprio perché possano scambiarsi qui.
 *
 * La scelta si fa a BUILD TIME (`VITE_REPLAY=1`), non a runtime: `isReplay`
 * diventa una costante e il ramo non scelto sparisce dal bundle. Il kiosk non
 * si porta dietro le registrazioni della vetrina, e la vetrina non si porta
 * dietro il client HTTP che non potrebbe usare. Perché funzioni davvero
 * servono due accortezze, spiegate in `vite.config.ts` e in `demo/replay.ts`.
 */
export const isReplay = import.meta.env.VITE_REPLAY === '1';

export const streamMessage = isReplay ? replayChat : streamChat;
export const loadMeta = isReplay ? replayMeta : fetchMeta;

/** Le domande proposte nella schermata iniziale. */
export const ESEMPI = isReplay
  ? // In demo NON possono essere esempi liberi: fuori da queste quattro non
    // esiste una risposta registrata, e proporne altre sarebbe un invito a
    // sbattere contro un muro.
    domandeRegistrate()
  : [
      'Il Postgres del progetto è su?',
      'Cosa ho modificato e non ho ancora committato?',
      'Come funziona la summary memory in questo progetto?',
      'Muovi il servomotore a 90 gradi',
    ];

export { RegistrazioneMancante, registratoIl } from './demo/replay';
