import { buildKeywordQuery } from './keyword-query.js';

describe('buildKeywordQuery', () => {
  it('mette i termini in OR, non in AND', () => {
    // È il cuore della correzione: in AND nessun chunk contiene tutte le
    // parole di una domanda, quindi la metà full-text restituisce zero e la
    // ricerca ibrida degenera in ricerca puramente vettoriale.
    expect(buildKeywordQuery('breakpoint cache automatico')).toBe(
      'breakpoint or cache or automatico',
    );
  });

  it('scarta le parole di servizio, che matcherebbero mezzo progetto', () => {
    const query = buildKeywordQuery(
      'dove viene applicato il breakpoint di cache quando il RAG è attivo?',
    );

    expect(query).not.toContain('dove');
    expect(query).not.toContain('quando');
    expect(query).toContain('breakpoint');
    expect(query).toContain('cache');
    expect(query).toContain('rag');
  });

  it('conserva gli identificatori interi, underscore compresi', () => {
    // Se `snake_case` venisse spezzato, la ricerca esatta sugli
    // identificatori — l'unica cosa che il full-text fa meglio dei vettori —
    // smetterebbe di funzionare.
    expect(buildKeywordQuery('cerca summary_through_message_id')).toBe(
      'cerca or summary_through_message_id',
    );
  });

  it('tiene le parole accentate', () => {
    expect(buildKeywordQuery('velocità però')).toContain('velocità');
  });

  it('deduplica i termini ripetuti', () => {
    expect(buildKeywordQuery('cache cache cache')).toBe('cache');
  });

  it('scarta i termini troppo corti', () => {
    expect(buildKeywordQuery('di a in cache')).toBe('cache');
  });

  it('restituisce stringa vuota se non resta nulla di utile', () => {
    // websearch_to_tsquery('') produce un tsquery che non matcha niente:
    // la metà full-text resta vuota, la semantica lavora comunque.
    expect(buildKeywordQuery('come e perché?')).toBe('');
  });
});
