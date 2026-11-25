import type { Pos } from './inflect';

/** The static, content-hashed verified lexicon (backend/scripts/cosmos/build_lexicon.py). */
export interface LexiconFile {
  v: number; source: string; sourceSha256: string;
  core: number[]; lemmas: string[]; lexfiles: string[];
  senses: [number, number][];                 // [lemma, synset]
  synsets: [string, number, string, string][]; // [pos, lexfile, gloss, name-if-not-a-member]
  synRel: [string, number, number][];          // [H|I|P, general/whole, specific/part] or [R, a, b] adjective similar-to
  senseRel: [string, number, number][];        // [A|D, senseA, senseB]
}

/** Indexed lexicon. Everything is a sense or a synset id: a surface word is never a relation endpoint. */
export class Lexicon {
  readonly lemmaIndex = new Map<string, number>();
  readonly sensesOf: number[][];            // lemma -> senses in OEWN order (most common first)
  readonly membersOf = new Map<number, number[]>(); // synset -> senses
  readonly parents = new Map<number, { syn: number; instance: boolean }[]>();
  readonly children = new Map<number, number[]>();
  readonly wholes = new Map<number, number[]>(); // part synset -> whole synsets
  readonly parts = new Map<number, number[]>();
  readonly senseRels = new Map<number, { code: 'A' | 'D'; other: number }[]>();
  readonly similar = new Map<number, number[]>(); // adjective synset -> its cluster neighbours (head / satellites)
  readonly core: Set<number>;

  constructor(readonly file: LexiconFile) {
    file.lemmas.forEach((l, i) => this.lemmaIndex.set(l, i));
    this.sensesOf = file.lemmas.map(() => []);
    file.senses.forEach(([lemma, syn], i) => {
      this.sensesOf[lemma].push(i);
      push(this.membersOf, syn, i);
    });
    for (const [code, a, b] of file.synRel) {
      if (code === 'P') { push(this.wholes, b, a); push(this.parts, a, b); }
      else if (code === 'R') { push(this.similar, a, b); push(this.similar, b, a); }
      else { push(this.parents, b, { syn: a, instance: code === 'I' }); push(this.children, a, b); }
    }
    for (const [code, a, b] of file.senseRel) {
      push(this.senseRels, a, { code: code as 'A' | 'D', other: b });
      push(this.senseRels, b, { code: code as 'A' | 'D', other: a });
    }
    this.core = new Set(file.core);
  }

  lemmaOf(sense: number): string { return this.file.lemmas[this.file.senses[sense][0]]; }
  synOf(sense: number): number { return this.file.senses[sense][1]; }
  pos(syn: number): Pos { return this.file.synsets[syn][0] as Pos; }
  gloss(syn: number): string { return this.file.synsets[syn][2]; }
  lexfile(syn: number): string { return this.file.lexfiles[this.file.synsets[syn][1]]; }
  /** A readable name for a synset: its first member lemma (or the stored name of an ancestor without kept members). */
  synName(syn: number): string {
    const m = this.membersOf.get(syn);
    return m?.length ? this.lemmaOf(m[0]) : this.file.synsets[syn][3] || '';
  }
  senses(word: string): number[] {
    const i = this.lemmaIndex.get(word);
    return i === undefined ? [] : this.sensesOf[i];
  }
  posSet(word: string): Set<Pos> { return new Set(this.senses(word).map(s => this.pos(this.synOf(s)))); }
  /** 1-based rank of a sense among its lemma's senses of the same part of speech (WordNet order ~ frequency). */
  rank(sense: number): number {
    const lemma = this.file.senses[sense][0], pos = this.pos(this.synOf(sense));
    let r = 0;
    for (const s of this.sensesOf[lemma]) { if (this.pos(this.synOf(s)) === pos) r++; if (s === sense) return r; }
    return r || 99;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}
