import { safeExec } from './safe-exec.js';

describe('safeExec', () => {
  const options = { cwd: process.cwd() };

  it('esegue un comando in whitelist', async () => {
    const result = await safeExec('git', ['--version'], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  it('rifiuta un comando fuori whitelist', async () => {
    // Whitelist e non blacklist: tutto è vietato tranne ciò che serve.
    await expect(safeExec('rm', ['-rf', '/tmp/x'], options)).rejects.toThrow(
      /non consentito/,
    );
    await expect(safeExec('bash', ['-c', 'echo ciao'], options)).rejects.toThrow(
      /non consentito/,
    );
  });

  it('NON interpreta i metacaratteri di shell', async () => {
    // Il test che vale più di tutti gli altri.
    //
    // Attenzione a come si verifica: cercare la stringa iniettata nell'output
    // NON funziona, perché molti comandi la ristampano verbatim quando non la
    // riconoscono — e ritrovarla è prova che è stata trattata come TESTO, non
    // che sia stata eseguita.
    //
    // Il segnale giusto è l'assenza dell'EFFETTO: se una shell interpretasse
    // questo argomento, eseguirebbe `git --version` e in stdout comparirebbe
    // "git version". Con execFile git riceve un solo argomento incomprensibile
    // e fallisce.
    const result = await safeExec('git', ['--version; echo PWNED'], options);

    expect(result.stdout).not.toContain('git version');
    expect(result.exitCode).not.toBe(0);
  });

  it('non passa le variabili di ambiente del processo', async () => {
    // L'agente esegue comandi: non devono poter leggere le API key che
    // vivono in process.env.
    process.env.SEGRETO_DI_TEST = 'valore-riservato';
    try {
      const result = await safeExec('git', ['var', 'GIT_EDITOR'], options);

      expect(result.stdout).not.toContain('valore-riservato');
    } finally {
      delete process.env.SEGRETO_DI_TEST;
    }
  });

  it('restituisce un exit code non-zero come risultato, non come eccezione', async () => {
    // `git diff` su un ref inesistente fallisce: per il modello è
    // un'informazione, non un crash da propagare.
    const result = await safeExec('git', ['rev-parse', 'ref-inesistente'], options);

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('segnala il timeout invece di restare appeso', async () => {
    // `git ls-remote` verso un host inesistente resta in attesa: con
    // timeoutMs basso deve essere ucciso e segnalato.
    const result = await safeExec(
      'git',
      ['ls-remote', 'https://192.0.2.1/repo.git'],
      { ...options, timeoutMs: 800 },
    );

    expect(result.exitCode).not.toBe(0);
  }, 20_000);
});
