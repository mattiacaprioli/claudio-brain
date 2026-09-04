import hljs from 'highlight.js/lib/common';
import type { ReactNode } from 'react';

/**
 * Renderer Markdown minimale, deliberatamente incompleto.
 *
 * PERCHÉ NON `marked` O SIMILI: quelle librerie producono HTML, e l'HTML va
 * iniettato con `dangerouslySetInnerHTML`. Ma il testo arriva da un LLM, che
 * può generare qualunque cosa — incluso `<script>` o un `onerror` in un tag
 * immagine. È lo stesso principio degli argomenti dei tool nella Fase 3:
 * **l'output di un modello è input non fidato**, qui per il browser.
 *
 * Con questo renderer non esiste passaggio di HTML: si producono nodi React,
 * che React escapa per costruzione. L'unica eccezione è il blocco di codice,
 * dove `highlight.js` genera markup — ma solo dopo aver escapato il contenuto,
 * ed è codice che gli passiamo noi, non HTML del modello.
 *
 * Cosa gestisce: blocchi ``` con linguaggio, `code` inline, **grassetto**,
 * intestazioni ##, elenchi. Basta per una risposta tecnica; il resto passa
 * come testo, che è il fallimento giusto.
 */
export function renderMarkdown(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  // Divide su blocchi di codice tenendo i delimitatori come gruppi catturati.
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);

  for (let index = 0; index < parts.length; index += 1) {
    // Il regex produce gruppi da 3: [prosa, linguaggio, codice, prosa, ...]
    const positionInTriplet = index % 3;

    if (positionInTriplet === 0) {
      blocks.push(...renderProse(parts[index], `p${index}`));
      continue;
    }
    if (positionInTriplet === 1) continue; // il linguaggio, letto sotto

    const language = parts[index - 1];
    blocks.push(
      <CodeBlock key={`c${index}`} language={language} code={parts[index]} />,
    );
  }

  return blocks;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const trimmed = code.replace(/\n$/, '');
  let html: string;
  try {
    html = language
      ? hljs.highlight(trimmed, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(trimmed).value;
  } catch {
    // Linguaggio non riconosciuto: meglio codice non colorato che un errore.
    html = escapeHtml(trimmed);
  }

  return (
    <pre className="code">
      {language ? <span className="code-lang">{language}</span> : null}
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function renderProse(chunk: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = chunk.split('\n');
  let list: string[] = [];

  const flushList = (key: string) => {
    if (list.length === 0) return;
    nodes.push(
      <ul key={key}>
        {list.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  lines.forEach((line, i) => {
    const key = `${keyPrefix}-${i}`;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);

    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flushList(`${key}-l`);

    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      nodes.push(<Tag key={key}>{renderInline(heading[2])}</Tag>);
      return;
    }
    if (line.trim().length === 0) return;

    nodes.push(<p key={key}>{renderInline(line)}</p>);
  });

  flushList(`${keyPrefix}-last`);
  return nodes;
}

/**
 * Codice inline, grassetto e corsivo. Tutto il resto resta testo.
 *
 * L'ordine nel regex conta: il codice inline va catturato PRIMA di grassetto e
 * corsivo, altrimenti un asterisco dentro un frammento di codice verrebbe
 * interpretato come formattazione. E il grassetto prima del corsivo, o `**x**`
 * verrebbe letto come corsivo di `*x*`.
 */
function renderInline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g)
    .map((piece, i) => {
      if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
        return <code key={i}>{piece.slice(1, -1)}</code>;
      }
      if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
        return <strong key={i}>{piece.slice(2, -2)}</strong>;
      }
      if (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) {
        return <em key={i}>{piece.slice(1, -1)}</em>;
      }
      return piece;
    });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
