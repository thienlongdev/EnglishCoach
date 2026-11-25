/**
 * Forward, part-of-speech-aware inflection: from a word the learner knows to the forms that may stand for it in a text.
 * Conservative by design (precision over recall): a noun gets plurals, a verb its -s / -ed / -ing forms and listed irregular
 * forms, an adjective its comparatives. "new" (adjective only) never yields "news". Unknown part of speech = the word itself.
 */
export type Pos = 'n' | 'v' | 'a' | 'r';

const IRREGULAR_VERBS = 'arise arose arisen|awake awoke awoken|be was were been am is are|bear bore borne|beat beaten|become became|begin began begun|bend bent|bet|bind bound|bite bit bitten|bleed bled|blow blew blown|break broke broken|breed bred|bring brought|build built|burn burnt|buy bought|catch caught|choose chose chosen|cling clung|come came|cost|creep crept|cut|deal dealt|dig dug|do did done does|draw drew drawn|dream dreamt|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|feed fed|feel felt|fight fought|find found|flee fled|fly flew flown flies|forbid forbade forbidden|forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten|give gave given|go went gone goes|grind ground|grow grew grown|hang hung|have had has|hear heard|hide hid hidden|hit|hold held|hurt|keep kept|kneel knelt|know knew known|lay laid|lead led|lean leant|leap leapt|learn learnt|leave left|lend lent|let|lie lay lain|light lit|lose lost|make made|mean meant|meet met|pay paid|put|quit|read|ride rode ridden|ring rang rung|rise rose risen|run ran|say said says|see saw seen|seek sought|sell sold|send sent|set|sew sewn|shake shook shaken|shine shone|shoot shot|show shown|shrink shrank shrunk|shut|sing sang sung|sink sank sunk|sit sat|sleep slept|slide slid|speak spoke spoken|speed sped|spend spent|spin spun|split|spread|spring sprang sprung|stand stood|steal stole stolen|stick stuck|sting stung|stink stank stunk|strike struck|swear swore sworn|sweep swept|swim swam swum|swing swung|take took taken|teach taught|tear tore torn|tell told|think thought|throw threw thrown|understand understood|upset|wake woke woken|wear wore worn|weave wove woven|weep wept|win won|wind wound|withdraw withdrew withdrawn|write wrote written';
const IRREGULAR_NOUNS = 'child children|man men|woman women|person people|foot feet|tooth teeth|mouse mice|goose geese|life lives|knife knives|wife wives|leaf leaves|half halves|wolf wolves|shelf shelves|thief thieves|loaf loaves|crisis crises|analysis analyses|thesis theses|phenomenon phenomena|criterion criteria|datum data|medium media';
const IRREGULAR_ADJ = 'good better best|bad worse worst|far farther further farthest furthest|little less least|many more most|much more most';

function table(src: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const row of src.split('|')) { const [base, ...forms] = row.split(' '); m.set(base, forms); }
  return m;
}
const VERBS = table(IRREGULAR_VERBS), NOUNS = table(IRREGULAR_NOUNS), ADJS = table(IRREGULAR_ADJ);
const VOWEL = /[aeiou]/;
const consonantY = (w: string) => w.length > 1 && w.endsWith('y') && !VOWEL.test(w[w.length - 2]);
const sibilant = (w: string) => /(s|x|z|ch|sh)$/.test(w);
/** Short CVC verbs / adjectives double the final consonant ("stop" -> "stopped", "hot" -> "hotter"). */
const doubles = (w: string) => w.length <= 4 && /[^aeiou][aeiou][bdgklmnprt]$/.test(w);

export function formsOf(word: string, pos: Iterable<Pos>): Set<string> {
  const w = word.toLowerCase();
  const out = new Set<string>([w]);
  if (w.includes(' ')) {
    // A phrase ("look after"): inflect its first word only when it is a verb phrase.
    const [head, ...rest] = w.split(' ');
    const tail = rest.join(' ');
    for (const p of pos) if (p === 'v') for (const f of formsOf(head, ['v'])) out.add(`${f} ${tail}`);
    return out;
  }
  for (const p of pos) {
    if (p === 'n') {
      NOUNS.get(w)?.forEach(f => out.add(f));
      if (!NOUNS.has(w)) out.add(consonantY(w) ? w.slice(0, -1) + 'ies' : sibilant(w) ? w + 'es' : w + 's');
    } else if (p === 'v') {
      VERBS.get(w)?.forEach(f => out.add(f));
      out.add(consonantY(w) ? w.slice(0, -1) + 'ies' : sibilant(w) || w.endsWith('o') ? w + 'es' : w + 's');
      if (!VERBS.has(w)) {
        if (w.endsWith('e')) out.add(w + 'd');
        else if (consonantY(w)) out.add(w.slice(0, -1) + 'ied');
        else if (doubles(w)) out.add(w + w.slice(-1) + 'ed');
        else out.add(w + 'ed');
      }
      if (w.endsWith('ie')) out.add(w.slice(0, -2) + 'ying');
      else if (w.endsWith('e') && !w.endsWith('ee')) out.add(w.slice(0, -1) + 'ing');
      else if (doubles(w)) out.add(w + w.slice(-1) + 'ing');
      else out.add(w + 'ing');
    } else if (p === 'a') {
      ADJS.get(w)?.forEach(f => out.add(f));
      if (!ADJS.has(w) && w.length <= 7 && !w.includes('-')) {
        const stem = consonantY(w) ? w.slice(0, -1) + 'i' : w.endsWith('e') ? w.slice(0, -1) : doubles(w) ? w + w.slice(-1) : w;
        out.add(stem + 'er'); out.add(stem + 'est');
      }
    }
  }
  return out;
}

export function posOf(raw: string | null | undefined): Pos | null {
  const p = (raw ?? '').trim().toLowerCase();
  if (p.startsWith('n')) return 'n';
  if (p.startsWith('v')) return 'v';
  if (p.startsWith('adj') || p === 'a' || p === 's') return 'a';
  if (p.startsWith('adv') || p === 'r') return 'r';
  return null;
}
