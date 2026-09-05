import { Controller, Get } from '@nestjs/common';

/**
 * Prende il posto dell'`AppController` dello scaffolding, e il motivo è
 * concreto: quel controller occupava `GET /` con "Hello World!", cioè
 * esattamente il path da cui deve arrivare la pagina. Un controller su `/`
 * vince sul fallback della SPA — con il risultato che la home mostra una
 * stringa di test e tutto il resto del sito funziona, che è il modo peggiore
 * di sbagliare perché sembra un problema del frontend.
 *
 * Al suo posto un endpoint che serve davvero nel deploy: `HEALTHCHECK` del
 * container, sonda del tunnel, verifica dopo un riavvio del Pi.
 *
 * È una sonda di LIVENESS: dice che il processo risponde, non che il sistema
 * funziona. Non tocca Postgres di proposito — una sonda che interroga il
 * database fa riavviare il container quando è il DATABASE ad avere problemi,
 * cioè spegne la cosa sbagliata. La verifica delle dipendenze (readiness) è un
 * endpoint diverso, da aggiungere quando ci sarà un orchestratore che sappia
 * distinguerli.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      // Utile davvero: dopo un crash-loop sul Pi, un uptime di due secondi
      // dice che il processo si è appena riavviato invece di essere su da ore.
      uptime: Math.round(process.uptime()),
    };
  }
}
