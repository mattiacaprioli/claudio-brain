import type { ConfigService } from '@nestjs/config';
import { HardwareTool } from './hardware.tool.js';

function tool(webhookUrl?: string): HardwareTool {
  const config = { get: () => webhookUrl } as unknown as ConfigService;
  return new HardwareTool(config);
}

describe('HardwareTool', () => {
  describe('modalità simulazione (nessun Raspberry configurato)', () => {
    it('dichiara ESPLICITAMENTE che l azione è simulata', async () => {
      const result = await tool().execute({ action: 'servo_move', angle: 90 });

      expect(result.isError).toBe(false);
      // È la riga che separa un agente onesto da uno che riferisce di aver
      // mosso un motore che non si è mosso.
      expect(result.content).toContain('SIMULATO');
      expect(result.content).toContain('90');
    });

    it('gestisce le azioni senza parametri', async () => {
      const result = await tool().execute({ action: 'led_on' });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('led_on');
    });
  });

  describe('validazione dei limiti fisici', () => {
    it('rifiuta un angolo fuori dai 0-180 gradi', async () => {
      // Non è pedanteria: un angolo fuori scala manda il servo a fondo corsa
      // e lo fa stallare col motore che continua a tirare.
      const troppo = await tool().execute({ action: 'servo_move', angle: 270 });
      const negativo = await tool().execute({ action: 'servo_move', angle: -10 });

      expect(troppo.isError).toBe(true);
      expect(troppo.content).toContain('0-180');
      expect(negativo.isError).toBe(true);
    });

    it('rifiuta servo_move senza angolo', async () => {
      const result = await tool().execute({ action: 'servo_move' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('angle');
    });

    it('rifiuta un angolo non numerico', async () => {
      const result = await tool().execute({ action: 'servo_move', angle: 'novanta' });

      expect(result.isError).toBe(true);
    });

    it('rifiuta un action inventata', async () => {
      const result = await tool().execute({ action: 'autodistruzione' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('servo_move');
    });

    it('rifiuta un input vuoto', async () => {
      expect((await tool().execute({})).isError).toBe(true);
      expect((await tool().execute(null)).isError).toBe(true);
    });
  });

  describe('modalità webhook', () => {
    it('inoltra l azione al Raspberry e riporta la risposta', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('servo a 45', { status: 200 }));

      const result = await tool('http://raspberry.local/hw').execute({
        action: 'servo_move',
        angle: 45,
      });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('servo a 45');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://raspberry.local/hw',
        expect.objectContaining({ method: 'POST' }),
      );
      fetchMock.mockRestore();
    });

    it('riporta un errore HTTP del Raspberry senza sollevare', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('servo bloccato', { status: 503 }));

      const result = await tool('http://raspberry.local/hw').execute({
        action: 'led_off',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('503');
      fetchMock.mockRestore();
    });

    it('riporta un Raspberry irraggiungibile come risultato, non come crash', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('fetch failed'));

      const result = await tool('http://raspberry.local/hw').execute({
        action: 'read_sensors',
      });

      // Un hardware spento è la norma: il modello deve poterlo dire all'utente.
      expect(result.isError).toBe(true);
      expect(result.content).toContain('non raggiungibile');
      fetchMock.mockRestore();
    });
  });
});
