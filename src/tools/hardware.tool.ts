import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ToolInputError,
  type AgentTool,
  type ToolResult,
} from './tool.interface.js';

type Action = 'servo_move' | 'led_on' | 'led_off' | 'read_sensors';
const ACTIONS: Action[] = ['servo_move', 'led_on', 'led_off', 'read_sensors'];

interface HardwareInput {
  action: Action;
  angle?: number;
}

/**
 * Ponte verso l'hardware del Raspberry Pi.
 *
 * Due modalità:
 *
 * - **webhook**: se `HARDWARE_WEBHOOK_URL` è impostata, l'azione viene
 *   inoltrata via POST al servizio che gira sul Pi.
 * - **simulazione**: altrimenti l'azione viene registrata e restituita come
 *   riuscita, dicendo esplicitamente che è simulata.
 *
 * La simulazione non è un ripiego: è il modo di sviluppare l'agente **prima**
 * di avere il Pi collegato, e di provare i prompt senza far muovere un
 * servomotore ad ogni test. Ma va dichiarata nel risultato, altrimenti il
 * modello riferisce all'utente "ho mosso il servo" quando non è vero — e la
 * differenza fra un agente e un bugiardo è proprio questa riga.
 */
@Injectable()
export class HardwareTool implements AgentTool {
  private readonly logger = new Logger(HardwareTool.name);
  private readonly webhookUrl: string | undefined;

  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('HARDWARE_WEBHOOK_URL') || undefined;
  }

  readonly definition: Anthropic.Tool = {
    name: 'trigger_hardware_action',
    description:
      'Comanda l\'hardware del robot collegato al Raspberry Pi: muove il ' +
      'servomotore, accende o spegne il LED, legge i sensori. Se il Raspberry ' +
      'non è configurato l\'azione viene simulata e il risultato lo dichiara.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            "'servo_move' richiede angle; 'led_on'/'led_off' non hanno " +
            "parametri; 'read_sensors' restituisce le letture correnti.",
        },
        angle: {
          type: 'number',
          description: 'Angolo del servomotore in gradi, da 0 a 180.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };

  async execute(rawInput: unknown): Promise<ToolResult> {
    let input: HardwareInput;
    try {
      input = this.validate(rawInput);
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }

    if (!this.webhookUrl) {
      this.logger.log(
        `[simulazione] ${input.action}${input.angle !== undefined ? ` angle=${input.angle}` : ''}`,
      );
      return {
        content:
          `SIMULATO (Raspberry Pi non configurato): azione "${input.action}"` +
          `${input.angle !== undefined ? ` con angolo ${input.angle}°` : ''} ` +
          'sarebbe stata eseguita. Imposta HARDWARE_WEBHOOK_URL per comandare ' +
          'l\'hardware reale.',
        isError: false,
      };
    }

    try {
      // Timeout stretto: l'hardware risponde in millisecondi, e una richiesta
      // appesa bloccherebbe il turno dell'agente.
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });

      const body = (await response.text()).slice(0, 1000);

      if (!response.ok) {
        return {
          content: `Il Raspberry ha risposto ${response.status}: ${body}`,
          isError: true,
        };
      }
      return { content: `Azione eseguita. Risposta: ${body || 'ok'}`, isError: false };
    } catch (error) {
      // Un hardware irraggiungibile è la norma, non un'eccezione da propagare:
      // il modello deve poterlo dire all'utente.
      return {
        content:
          `Raspberry non raggiungibile (${String((error as Error).message)}). ` +
          'Verifica che sia accesso e sulla stessa rete.',
        isError: true,
      };
    }
  }

  private validate(rawInput: unknown): HardwareInput {
    const input = (rawInput ?? {}) as Record<string, unknown>;

    if (!ACTIONS.includes(input.action as Action)) {
      throw new ToolInputError(
        `action non valida: "${String(input.action)}". Ammesse: ${ACTIONS.join(', ')}.`,
      );
    }
    const action = input.action as Action;

    if (action !== 'servo_move') {
      return { action };
    }

    // Il limite 0-180 non è pedanteria: un angolo fuori scala su un servo
    // reale lo manda a fondo corsa e lo fa stallare, con il motore che
    // continua a tirare. È un vincolo FISICO, e va verificato qui — non
    // sperando che il modello legga la descrizione.
    if (typeof input.angle !== 'number' || !Number.isFinite(input.angle)) {
      throw new ToolInputError("servo_move richiede 'angle' numerico.");
    }
    if (input.angle < 0 || input.angle > 180) {
      throw new ToolInputError(
        `angle fuori intervallo: ${input.angle}. Ammessi 0-180 gradi.`,
      );
    }

    return { action, angle: input.angle };
  }
}
