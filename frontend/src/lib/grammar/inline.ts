/**
 * Echo Grammar Academy: the two inline mark-ups of the content (docs/grammar/CONTENT-SCHEMA.md) and a few text helpers.
 *
 *  - English text may mark grammatical roles: `[S|She] [AUX|has] [V|lived] here [T|for five years].` Roles may nest
 *    (`[SUB|if [S|I] [V|were] you]`); the parser is tolerant: an unclosed role is closed at the end, a stray `]` or a `[` that
 *    does not open a role is plain text.
 *  - Vietnamese text has exactly two marks: `**bold**` and `` `form` `` (an English form quoted inside Vietnamese prose).
 *
 * Pure functions, no imports from React: every grammar screen (lesson, practice, lab, stories, detective) shares them.
 */
import type { Block } from '@/types/grammar';

export type RoleNode = { t: string } | { role: string; children: RoleNode[] };

/** One run of text with the innermost role that wraps it and the roles around that one (outermost first). */
export interface RoleSeg { t: string; role?: string; outer?: string[] }

const OPEN = /^\[([A-Z]{1,6})\|/;

type Frame = { kind: 'root' | 'role' | 'lit'; children: RoleNode[] };

/** Role mark-up as a tree. Text outside every role sits at the root. */
export function parseRoleTree(s: string): RoleNode[] {
  const root: RoleNode[] = [];
  const stack: Frame[] = [{ kind: 'root', children: root }];
  let buf = '';
  const top = () => stack[stack.length - 1];
  const flush = () => {
    if (buf) { top().children.push({ t: buf }); buf = ''; }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[') {
      const m = OPEN.exec(s.slice(i, i + 9));
      if (m) {
        flush();
        const node: { role: string; children: RoleNode[] } = { role: m[1], children: [] };
        top().children.push(node);
        stack.push({ kind: 'role', children: node.children });
        i += m[0].length - 1;
        continue;
      }
      // a bracket that opens no role: it and its closer are text
      buf += ch;
      stack.push({ kind: 'lit', children: top().children });
    } else if (ch === ']') {
      const t = top();
      if (t.kind === 'role') { flush(); stack.pop(); }
      else if (t.kind === 'lit') { buf += ch; stack.pop(); }
      else buf += ch;
    } else {
      buf += ch;
    }
  }
  flush();
  return root;
}

/** Role mark-up flattened to runs of text; each run knows its innermost role and the roles that enclose it. */
export function parseRoles(s: string): RoleSeg[] {
  const out: RoleSeg[] = [];
  const walk = (nodes: RoleNode[], chain: string[]) => {
    for (const n of nodes) {
      if ('t' in n) {
        if (!n.t) continue;
        if (!chain.length) out.push({ t: n.t });
        else if (chain.length === 1) out.push({ t: n.t, role: chain[0] });
        else out.push({ t: n.t, role: chain[chain.length - 1], outer: chain.slice(0, -1) });
      } else {
        walk(n.children, [...chain, n.role]);
      }
    }
  };
  walk(parseRoleTree(s), []);
  return out;
}

/** The sentence without its mark-up. */
export function plainRoles(s: string): string {
  return parseRoles(s).map((x) => x.t).join('');
}

/** Every role named by a string of English mark-up. */
export function rolesOf(s: string): string[] {
  const found = new Set<string>();
  const walk = (nodes: RoleNode[]) => {
    for (const n of nodes) if ('role' in n) { found.add(n.role); walk(n.children); }
  };
  walk(parseRoleTree(s));
  return [...found];
}

/** The roles a list of blocks uses (examples, contrasts, formulas, tables), so a legend can name only those. */
export function rolesInBlocks(blocks: Block[]): Set<string> {
  const used = new Set<string>();
  const add = (s: string | undefined) => { if (s && s.includes('|')) for (const r of rolesOf(s)) used.add(r); };
  for (const b of blocks) {
    if (b.type === 'examples') b.items.forEach((i) => add(i.en));
    else if (b.type === 'contrast') b.items.forEach((i) => { add(i.a.en); add(i.b.en); });
    else if (b.type === 'formula') {
      (b.parts ?? []).forEach((p) => p.role && used.add(p.role));
      (b.lines ?? []).forEach((l) => l.parts.forEach((p) => p.role && used.add(p.role)));
    } else if (b.type === 'table') b.rows.forEach((r) => r.forEach(add));
    else if (b.type === 'diagram') {
      const s = b.spec;
      if (s.kind === 'timeline') add(s.sentence);
      else if (s.kind === 'agent') { add(s.active); add(s.passive); }
      else if (s.kind === 'branch') s.branches.forEach((br) => { add(br.cond); add(br.result); });
    }
  }
  return used;
}

export type InlineNode =
  | { k: 'text'; t: string }
  | { k: 'b'; children: InlineNode[] }
  | { k: 'code'; t: string };

/** Vietnamese inline mark-up: `**bold**` (may contain a `form`) and `` `form` ``. An unclosed mark is plain text. */
export function parseInline(s: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) { out.push({ k: 'text', t: buf }); buf = ''; }
  };
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) {
        flush();
        out.push({ k: 'b', children: parseInline(s.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }
    if (s[i] === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ k: 'code', t: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/** The text of Vietnamese mark-up without its marks. */
export function plainInline(s: string): string {
  const flat = (nodes: InlineNode[]): string => nodes.map((n) => (n.k === 'b' ? flat(n.children) : n.t)).join('');
  return flat(parseInline(s));
}

/** Lower case, no diacritics, đ as d: the form used to compare what a learner types with what is written. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

/** Folded words of a string (letters and digits only). */
export function foldTokens(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Words of an English sentence, punctuation split off (used by the word-moving diagrams). */
export function wordKey(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '').replace(/[’]/g, "'");
}
