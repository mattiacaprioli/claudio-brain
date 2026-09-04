import { GitDiffTool } from './git-diff.tool.js';

/**
 * Questi test eseguono `git` DAVVERO sul repository del progetto: sono
 * gratuiti (nessuna API) e verificano ciò che conta di più in un tool — la
 * validazione dell'input, che arriva da un modello e non da un client fidato.
 */
describe('GitDiffTool', () => {
  const tool = new GitDiffTool();

  describe('validazione (input dal modello = input non fidato)', () => {
    it('rifiuta un mode inventato', async () => {
      const result = await tool.execute({ mode: 'tutto-il-repo' });

      expect(result.isError).toBe(true);
      // L'errore dice anche i valori ammessi: il modello può correggersi.
      expect(result.content).toContain('unstaged, staged, last-commit');
    });

    it('rifiuta un path assoluto', async () => {
      const result = await tool.execute({ path: '/etc/passwd' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('non assoluto');
    });

    it('rifiuta la risalita con ..', async () => {
      // Senza questo controllo il tool leggerebbe qualunque file del disco.
      const result = await tool.execute({ path: '../../../etc/shadow' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('non può uscire');
    });

    it('rifiuta un path che non è una stringa', async () => {
      const result = await tool.execute({ path: 42 });

      expect(result.isError).toBe(true);
    });

    it('accetta un input vuoto usando i default', async () => {
      const result = await tool.execute({});

      // Su un working tree pulito il messaggio è informativo, non un errore.
      expect(result.isError).toBe(false);
    });

    it('accetta input null o undefined', async () => {
      expect((await tool.execute(null)).isError).toBe(false);
      expect((await tool.execute(undefined)).isError).toBe(false);
    });
  });

  describe('definizione esposta al modello', () => {
    it('dichiara nome, descrizione e schema', () => {
      expect(tool.definition.name).toBe('read_git_diff');
      // La descrizione dice anche cosa NON fa: serve a impedire che il modello
      // provi a usarlo per leggere file arbitrari.
      expect(tool.definition.description).toContain('Non può leggere altri repository');
      expect(tool.definition.input_schema.properties).toHaveProperty('mode');
      expect(tool.definition.input_schema.properties).toHaveProperty('path');
    });

    it('vieta proprietà non previste nello schema', () => {
      expect(tool.definition.input_schema.additionalProperties).toBe(false);
    });
  });

  describe('esecuzione reale', () => {
    it("legge l'ultimo commit del progetto", async () => {
      const result = await tool.execute({ mode: 'last-commit' });

      expect(result.isError).toBe(false);
      // Il primo commit del progetto contiene queste cose.
      expect(result.content).toMatch(/commit|file changed|insertion/i);
    });

    it('restringe il diff a un percorso senza errori', async () => {
      const result = await tool.execute({ mode: 'last-commit', path: 'src/tools' });

      expect(result.isError).toBe(false);
    });

    it('mette il riepilogo dei file PRIMA del dettaglio', async () => {
      const result = await tool.execute({ mode: 'unstaged' });

      // Se non ci sono modifiche il messaggio è informativo; se ci sono, il
      // riepilogo deve precedere il patch. Serve perché un diff reale supera
      // il tetto di troncamento: senza l'elenco dei file, oltre il punto di
      // taglio il modello non sa nemmeno cosa gli manca.
      if (result.content.startsWith('Nessuna modifica')) return;

      expect(result.content).toContain('RIEPILOGO DEI FILE MODIFICATI');
      expect(result.content.indexOf('RIEPILOGO')).toBeLessThan(
        result.content.indexOf('DETTAGLIO'),
      );
    });
  });
});
