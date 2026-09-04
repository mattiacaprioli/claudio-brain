/**
 * Trasforma una domanda in linguaggio naturale in una query full-text utile.
 *
 * IL PROBLEMA. `websearch_to_tsquery` mette in **AND** tutti i termini: la
 * domanda "dove viene applicato il breakpoint di cache quando il RAG è attivo?"
 * diventa una richiesta di chunk che contengano *tutte* quelle parole insieme.
 * Nessun chunk le contiene, quindi la metà full-text della ricerca ibrida
 * restituisce zero risultati — e la ricerca ibrida degenera silenziosamente in
 * ricerca puramente vettoriale, cioè proprio ciò che volevamo evitare.
 *
 * Il difetto non si vede con una query breve (`findRecentMessagesAfter`
 * funziona benissimo in AND, è un solo termine): compare solo con le domande
 * vere, ed è per questo che è sopravvissuto ai test.
 *
 * LA SOLUZIONE. Termini in **OR**, così un chunk che ne contiene alcuni viene
 * trovato, e `ts_rank_cd` premia quelli che ne contengono di più.
 *
 * Restiamo su `websearch_to_tsquery` (che capisce la parola `or`) invece di
 * costruire un `to_tsquery` a mano, perché accetta input umano qualunque senza
 * sollevare errori di sintassi.
 */

/**
 * Parole troppo comuni per essere discriminanti.
 *
 * Servono perché l'indice usa la configurazione `simple`, che di proposito
 * NON rimuove le stopword — scelta giusta per il codice, dove "not", "if" e
 * "for" sono parole vere. Il prezzo è che il filtro va fatto qui: senza,
 * "non" in OR matcherebbe mezzo progetto e `ts_rank_cd`, che pesa la
 * frequenza e non la rarità, porterebbe in alto il chunk più verboso.
 */
const STOPWORDS = new Set([
  // italiano
  'come', 'cosa', 'dove', 'quando', 'perche', 'perché', 'quale', 'quali',
  'viene', 'vengono', 'essere', 'sono', 'stato', 'stata', 'della', 'dello',
  'delle', 'degli', 'nel', 'nei', 'nella', 'nelle', 'con', 'per', 'che',
  'non', 'più', 'piu', 'poi', 'gli', 'una', 'uno', 'suo', 'sua', 'mio', 'mia',
  'questo', 'questa', 'quello', 'quella', 'fare', 'fatto', 'usa', 'usare',
  'serve', 'servono', 'ho', 'hai', 'era', 'anche', 'solo', 'tutti', 'tutto',
  // inglese
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'what', 'where',
  'when', 'why', 'how', 'does', 'are', 'was', 'were', 'has', 'have', 'can',
  'should', 'would', 'about', 'into', 'there', 'here', 'you', 'your',
]);

/** Sotto questa lunghezza un termine è quasi sempre rumore. */
const MIN_TERM_LENGTH = 3;

export function buildKeywordQuery(text: string): string {
  // \p{L} e \p{N} con il flag `u`: tiene accenti e cifre, e non spezza gli
  // identificatori sugli underscore.
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];

  const kept = terms.filter(
    (term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term),
  );

  // Deduplica mantenendo l'ordine: un termine ripetuto non aggiunge nulla
  // alla query, e allunga solo il tsquery.
  return [...new Set(kept)].join(' or ');
}
