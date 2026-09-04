import type Anthropic from '@anthropic-ai/sdk';
import type { ConfigService } from '@nestjs/config';
import type { LlmService, LlmTurn } from '../llm/llm.service.js';
import type { ToolsService } from '../tools/tools.service.js';
import { AgentService } from './agent.service.js';

/**
 * Il loop dell'agente testato con un LLM finto che restituisce turni
 * prestabiliti: nessuna chiamata di rete, nessun costo, e possiamo forzare
 * scenari che dal vero sarebbero difficili da riprodurre (un modello che
 * insiste su uno strumento rotto, tool paralleli, un tetto raggiunto).
 */

function textTurn(text: string): LlmTurn {
  return {
    content: [{ type: 'text', text, citations: [] } as Anthropic.TextBlock],
    stopReason: 'end_turn',
    text,
    toolUses: [],
    model: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function toolTurn(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): LlmTurn {
  const blocks = toolUses.map(
    (use) =>
      ({
        type: 'tool_use',
        id: use.id,
        name: use.name,
        input: use.input,
      }) as Anthropic.ToolUseBlock,
  );
  return {
    content: blocks,
    stopReason: 'tool_use',
    text: '',
    toolUses: blocks,
    model: 'claude-opus-5',
    inputTokens: 20,
    outputTokens: 8,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function build(turns: LlmTurn[], options: { maxIterations?: number } = {}) {
  const sent: Anthropic.MessageParam[][] = [];
  const llm = {
    converse: vi.fn(async (messages: Anthropic.MessageParam[]) => {
      sent.push(structuredClone(messages));
      return turns.shift() ?? textTurn('finito');
    }),
  } as unknown as LlmService;

  const executed: string[] = [];
  const tools = {
    definitions: () => [
      { name: 'read_git_diff', description: 'x', input_schema: { type: 'object' } },
    ] as Anthropic.Tool[],
    isEmpty: false,
    executeAll: vi.fn(async (uses: Anthropic.ToolUseBlock[]) =>
      uses.map((use) => {
        executed.push(use.name);
        return {
          toolUseId: use.id,
          name: use.name,
          input: use.input,
          result: { content: `output di ${use.name}`, isError: false },
          durationMs: 3,
        };
      }),
    ),
  } as unknown as ToolsService;

  const config = {
    get: () => options.maxIterations?.toString(),
  } as unknown as ConfigService;

  return { agent: new AgentService(llm, tools, config), llm, tools, sent, executed };
}

describe('AgentService', () => {
  it('senza strumenti conclude in un giro', async () => {
    const { agent } = build([textTurn('ciao')]);

    const run = await agent.run([{ role: 'user', content: 'ciao' }]);

    expect(run.text).toBe('ciao');
    expect(run.iterations).toBe(1);
    expect(run.executions).toEqual([]);
  });

  it('esegue lo strumento e richiama il modello', async () => {
    const { agent, executed } = build([
      toolTurn([{ id: 'tu_1', name: 'read_git_diff', input: {} }]),
      textTurn('Ecco le tue modifiche.'),
    ]);

    const run = await agent.run([{ role: 'user', content: 'cosa ho modificato?' }]);

    expect(executed).toEqual(['read_git_diff']);
    expect(run.iterations).toBe(2);
    expect(run.text).toBe('Ecco le tue modifiche.');
  });

  it('rimanda indietro i blocchi del modello INVARIATI', async () => {
    const { agent, sent } = build([
      toolTurn([{ id: 'tu_1', name: 'read_git_diff', input: { mode: 'staged' } }]),
      textTurn('fatto'),
    ]);

    await agent.run([{ role: 'user', content: 'domanda' }]);

    // Alla seconda chiamata il messaggio assistant deve contenere il blocco
    // tool_use originale: ricostruirlo dal testo perderebbe i blocchi
    // thinking e farebbe rifiutare la richiesta.
    const secondCall = sent[1];
    const assistant = secondCall[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'read_git_diff', input: { mode: 'staged' } },
    ]);
  });

  it('mette TUTTI i tool_result in UN SOLO messaggio user', async () => {
    const { agent, sent } = build([
      toolTurn([
        { id: 'tu_1', name: 'read_git_diff', input: {} },
        { id: 'tu_2', name: 'get_docker_status', input: {} },
      ]),
      textTurn('fatto'),
    ]);

    await agent.run([{ role: 'user', content: 'stato del progetto?' }]);

    // Spezzarli in due messaggi insegna al modello a non chiedere più
    // strumenti in parallelo: peggiora il comportamento in modo permanente.
    const secondCall = sent[1];
    expect(secondCall).toHaveLength(3); // user, assistant, user(results)
    const results = secondCall[2].content as Anthropic.ToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results.map((block) => block.tool_use_id)).toEqual(['tu_1', 'tu_2']);
  });

  it('propaga is_error al modello', async () => {
    const { agent, sent, tools } = build([
      toolTurn([{ id: 'tu_1', name: 'read_git_diff', input: {} }]),
      textTurn('spiego l errore'),
    ]);
    vi.mocked(tools.executeAll).mockResolvedValueOnce([
      {
        toolUseId: 'tu_1',
        name: 'read_git_diff',
        input: {},
        result: { content: 'non è un repository', isError: true },
        durationMs: 1,
      },
    ]);

    await agent.run([{ role: 'user', content: 'diff?' }]);

    const results = sent[1][2].content as Anthropic.ToolResultBlockParam[];
    // Senza is_error il modello crede che sia andato tutto bene e riferisce
    // il messaggio d'errore come se fosse il contenuto del diff.
    expect(results[0].is_error).toBe(true);
  });

  it('si ferma al tetto di iterazioni invece di girare all infinito', async () => {
    // Un modello che insiste sullo stesso strumento: senza tetto brucerebbe
    // token finché non finisce il credito.
    const insistente = Array.from({ length: 10 }, (_, i) =>
      toolTurn([{ id: `tu_${i}`, name: 'read_git_diff', input: {} }]),
    );
    const { agent } = build(insistente, { maxIterations: 3 });

    const run = await agent.run([{ role: 'user', content: 'diff?' }]);

    expect(run.iterations).toBe(3);
    expect(run.executions).toHaveLength(3);
    expect(run.text).toContain('Ho interrotto');
  });

  it('somma i token di TUTTI i giri', async () => {
    const { agent } = build([
      toolTurn([{ id: 'tu_1', name: 'read_git_diff', input: {} }]),
      textTurn('fatto'),
    ]);

    const run = await agent.run([{ role: 'user', content: 'x' }]);

    // Un turno con strumenti costa più chiamate: riportare solo l'ultima
    // sottostimerebbe il costo reale, che è la cosa che vogliamo misurare.
    expect(run.inputTokens).toBe(30); // 20 + 10
    expect(run.outputTokens).toBe(13); // 8 + 5
  });

  it('usa il breakpoint esplicito solo alla prima richiesta', async () => {
    const { agent, llm } = build([
      toolTurn([{ id: 'tu_1', name: 'read_git_diff', input: {} }]),
      textTurn('fatto'),
    ]);

    await agent.run([{ role: 'user', content: 'x' }], { cacheUpToIndex: 0 });

    // Dal secondo giro la coda è cresciuta con i blocchi dei tool, quindi
    // l'indice calcolato prima non punta più alla fine del prefisso stabile.
    expect(vi.mocked(llm.converse).mock.calls[0][1]).toMatchObject({
      cacheUpToIndex: 0,
    });
    expect(vi.mocked(llm.converse).mock.calls[1][1]).toMatchObject({
      cacheUpToIndex: undefined,
      cache: true,
    });
  });
});
