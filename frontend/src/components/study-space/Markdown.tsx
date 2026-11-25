import React from 'react';

/**
 * A small Markdown renderer that builds React elements (never HTML strings: 10 §U forbids markup sinks). Headings,
 * paragraphs, bullet / numbered / check lists, **bold**, *italic*, `code` and http(s) links.
 */

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) out.push(<a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">{t.slice(1, t.indexOf(']'))}</a>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text, className, onToggle }: { text: string; className?: string; onToggle?: (line: number) => void }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: React.ReactNode[] } | null = null;
  const flush = () => {
    if (!list) return;
    blocks.push(list.ordered ? <ol key={`l${blocks.length}`}>{list.items}</ol> : <ul key={`l${blocks.length}`}>{list.items}</ul>);
    list = null;
  };
  lines.forEach((raw, n) => {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const check = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { flush(); const Tag = (`h${h[1].length}`) as 'h1' | 'h2' | 'h3'; blocks.push(<Tag key={n}>{inline(h[2], `h${n}`)}</Tag>); return; }
    if (check) {
      if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; }
      const done = check[1] !== ' ';
      list.items.push(
        <li key={n} style={{ listStyle: 'none', marginLeft: -18 }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: onToggle ? 'pointer' : 'default' }}>
            <input type="checkbox" checked={done} readOnly={!onToggle} onChange={() => onToggle?.(n)} />
            <span style={done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{inline(check[2], `c${n}`)}</span>
          </label>
        </li>,
      );
      return;
    }
    if (bullet || num) {
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(<li key={n}>{inline((bullet ?? num)![1], `b${n}`)}</li>);
      return;
    }
    flush();
    if (line.trim()) blocks.push(<p key={n}>{inline(line, `p${n}`)}</p>);
  });
  flush();
  return <div className={className}>{blocks}</div>;
}
