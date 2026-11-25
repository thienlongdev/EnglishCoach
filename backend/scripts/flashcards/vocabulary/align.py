"""Step 1 — sense alignment (owner brief 2026-10-30).

For every English headword of the EN-VI dictionary that occurs in a Tatoeba English-Vietnamese pair, find the dictionary
sense whose Vietnamese wording the HUMAN translator actually used for that word in that sentence. A card is only ever
built from such an attested (word, sense, example, translation) tuple: the meaning shown, the example and its Vietnamese
translation then demonstrate the same sense by construction. No machine translation, no generated text.

Guards against accidental matches: the Vietnamese term must be far more frequent in translations of sentences that contain
the word than in the corpus overall (lift), generic one-syllable function words never count, and terms must be short
lexical wordings (not definitions).

usage: python align.py <source cache dir> <out.json>
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import sources as S

IRREGULAR = """arise arose arisen|awake awoke awoken|be was were been being is am are|bear bore born borne|beat beat beaten|
become became become|begin began begun|bend bent|bet bet|bind bound|bite bit bitten|bleed bled|blow blew blown|break broke broken|
breed bred|bring brought|broadcast broadcast|build built|burn burnt burned|burst burst|buy bought|catch caught|choose chose chosen|
cling clung|come came come|cost cost|creep crept|cut cut|deal dealt|dig dug|do did done does|draw drew drawn|dream dreamt dreamed|
drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|feed fed|feel felt|fight fought|find found|flee fled|fly flew flown flies|
forbid forbade forbidden|forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten|give gave given|go went gone goes|
grind ground|grow grew grown|hang hung|have had has|hear heard|hide hid hidden|hit hit|hold held|hurt hurt|keep kept|kneel knelt|
know knew known|lay laid|lead led|lean leant leaned|leap leapt leaped|learn learnt learned|leave left|lend lent|let let|lie lay lain|
light lit lighted|lose lost|make made|mean meant|meet met|mistake mistook mistaken|pay paid|prove proved proven|put put|quit quit|read read|
ride rode ridden|ring rang rung|rise rose risen|run ran run|say said says|see saw seen|seek sought|sell sold|send sent|set set|sew sewed sewn|
shake shook shaken|shine shone|shoot shot|show showed shown|shrink shrank shrunk|shut shut|sing sang sung|sink sank sunk|sit sat|sleep slept|
slide slid|smell smelt smelled|speak spoke spoken|speed sped|spell spelt spelled|spend spent|spill spilt spilled|spin spun|spit spat|split split|
spoil spoilt spoiled|spread spread|spring sprang sprung|stand stood|steal stole stolen|stick stuck|sting stung|stink stank stunk|strike struck|
string strung|strive strove striven|swear swore sworn|sweep swept|swell swelled swollen|swim swam swum|swing swung|take took taken|
teach taught|tear tore torn|tell told|think thought|throw threw thrown|understand understood|upset upset|wake woke woken|wear wore worn|
weave wove woven|weep wept|win won|wind wound|withdraw withdrew withdrawn|write wrote written|child children|man men|woman women|
person people|tooth teeth|foot feet|mouse mice|goose geese|knife knives|wife wives|life lives|leaf leaves|half halves|wolf wolves|
shelf shelves|thief thieves|loaf loaves|potato potatoes|tomato tomatoes|hero heroes|good better best|bad worse worst|far farther further"""

# Vietnamese words that can never carry a sense on their own (function words, copulas, classifiers).
GENERIC = set("""có là được cho đi lên ra vào với của một những các cái con chiếc người việc sự điều cuộc nhà làm bị đã sẽ đang
rất này kia đó ấy thì mà và hay hoặc nhưng không chưa còn cũng vẫn lại nữa thôi nào gì ai đâu sao bao để từ về theo trong ngoài
trên dưới tại như khi nếu vì bởi nên thế vậy tôi bạn anh chị em họ nó ông bà cô chú""".split())

CLASSIFIERS = ('sự ', 'cái ', 'con ', 'chiếc ', 'việc ', 'cuộc ', 'điều ', 'những ', 'các ', 'nhà ', 'người ')
NOTE = re.compile(r'(quá khứ|phân từ|số nhiều|ngôi thứ|dạng|viết tắt|xem |như |= |thuộc về )', re.I)
WORD_OK = re.compile(r"^[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,2}$")
SYL = re.compile(r'\S+')


def forms_of(word, irregular):
    if ' ' in word:
        head, rest = word.split(' ', 1)
        return {f + ' ' + rest for f in forms_of(head, irregular)}
    out = {word, word + 's', word + 'es', word + 'ed', word + 'd', word + 'ing', word + 'er', word + 'est'}
    if word.endswith('y') and len(word) > 2 and word[-2] not in 'aeiou':
        out |= {word[:-1] + 'ies', word[:-1] + 'ied', word[:-1] + 'ier', word[:-1] + 'iest'}
    if word.endswith('e'):
        out |= {word[:-1] + 'ing', word + 'd', word + 'r', word + 'st'}
    if len(word) >= 3 and word[-1] not in 'aeiouwxy' and word[-2] in 'aeiou' and word[-3] not in 'aeiou':
        out |= {word + word[-1] + 'ed', word + word[-1] + 'ing', word + word[-1] + 'er', word + word[-1] + 'est'}
    out |= irregular.get(word, set())
    return out


def terms_of(gloss):
    g = re.sub(r'\([^)]*\)', ' ', gloss)
    g = re.sub(r'\[[^\]]*\]', ' ', g)
    out = []
    for t in re.split(r'[;,/]| hoặc ', g):
        t = S.nfc(t).strip().strip('.').strip().lower()
        t = re.sub(r'\s+', ' ', t)
        if not t or NOTE.search(t) or any(c.isdigit() for c in t):
            continue
        if len(SYL.findall(t)) > 4:
            continue
        out.append(t)
    return out


def variants(term):
    v = [term]
    for c in CLASSIFIERS:
        if term.startswith(c) and len(term) > len(c) + 1:
            v.append(term[len(c):])
    return v


NAMES = re.compile(r'\b(Tom|Mary|John|Jim|Ken|Bob|Jack|Mike|Alice|Kate|Maria|Ziri|Sami|Layla|Fadil|Dan|Linda)\b')


def example_rank(ex):
    en, vi = ex['en'], ex['vi']
    n = len(en.split())
    return (
        not (4 <= n <= 14),
        bool(NAMES.search(en)),
        not en[:1].isupper() or en[-1:] not in '.?!' or vi[-1:] not in '.?!',
        '&' in en or '&' in vi or '"' in en,
        abs(n - 8),
    )


def contains(vi, term):
    return f' {term} ' in vi


def main(cache, out_path):
    cache = Path(cache)
    lock = S.verify(cache)
    irregular = defaultdict(set)
    for group in IRREGULAR.replace('\n', '').split('|'):
        ws = group.split()
        irregular[ws[0]] |= set(ws[1:])
    lex = S.load_sqlite()
    pairs = S.load_tatoeba(cache)
    cefr = S.load_cefr(cache)
    wn_lemmas, wn_synsets = S.load_wordnet(cache)
    print('sqlite', len(lex), 'pairs', len(pairs), 'cefr', len(cefr), 'wordnet', len(wn_lemmas))

    # index English sentences by token n-grams (1..3)
    eng_vi = defaultdict(list)          # eng id -> [(vie id, normalized vi)]
    eng_text = {}
    for eid, en, vid, vi in pairs:
        eng_text[eid] = en
        eng_vi[eid].append((vid, ' ' + re.sub(r'[^\w\s]', ' ', vi.lower()).replace('  ', ' ') + ' ', vi))
    gram_index = defaultdict(set)
    for eid, en in eng_text.items():
        toks = S.tokens(en)
        for n in (1, 2, 3):
            for i in range(len(toks) - n + 1):
                gram_index[' '.join(toks[i:i + n])].add(eid)
    n_eng = len(eng_text)

    # corpus frequency of a Vietnamese term (share of English sentences whose translations contain it)
    vi_grams = {}
    df_counter = Counter()
    for eid, vs in eng_vi.items():
        grams = set()
        for _, v, _ in vs:
            syl = v.split()
            for n in (1, 2, 3, 4):
                for i in range(len(syl) - n + 1):
                    grams.add(' '.join(syl[i:i + n]))
        vi_grams[eid] = grams
        df_counter.update(grams)

    def term_df(term):
        return df_counter.get(term, 0)

    results = []
    for word, entry in lex.items():
        if not WORD_OK.match(word):
            continue
        sent_ids = set()
        for f in forms_of(word, irregular):
            sent_ids |= gram_index.get(f, set())
        if not sent_ids:
            continue
        best = None
        for idx, (pos, gloss) in enumerate(entry['senses']):
            for term in terms_of(gloss):
                for var in variants(term):
                    if var in GENERIC or len(var) < 2:
                        continue
                    hits = [eid for eid in sent_ids if var in vi_grams[eid]]
                    if not hits:
                        continue
                    df = term_df(var)
                    lift = (len(hits) / len(sent_ids)) / max(df / n_eng, 1e-9)
                    one_syl = ' ' not in var
                    if lift < (20 if one_syl else 10) or (len(hits) == 1 and lift < 50):
                        continue
                    score = (len(hits), (word, pos) in cefr, -idx, len(var))
                    if best is None or score > best['score']:
                        best = {'score': score, 'pos': pos, 'gloss': gloss, 'senseIndex': idx, 'term': var,
                                'hits': hits, 'lift': round(lift, 1), 'occurrences': len(sent_ids)}
        if not best:
            continue
        examples = []
        for eid in best['hits']:
            for vid, vnorm, vi in eng_vi[eid]:
                if contains(vnorm, best['term']):
                    examples.append({'enId': eid, 'en': eng_text[eid], 'viId': vid, 'vi': vi})
                    break
        examples.sort(key=example_rank)
        cap_word = re.compile(r'(?<=[a-z,;:] )' + re.escape(word[:1].upper() + word[1:]) + r'\b')
        capital = sum(1 for eid in sent_ids if cap_word.search(eng_text[eid]))
        wn = wn_lemmas.get(word, {}).get(best['pos'], [])
        first = wn_synsets.get(wn[0]) if wn else None
        chain, cur, seen = [], first, 0
        while cur and cur['hyper'] and seen < 12:
            nxt = wn_synsets.get(cur['hyper'][0])
            if not nxt:
                break
            chain.append(nxt['members'][0].replace('oewn-', '') if nxt['members'] else '')
            cur, seen = nxt, seen + 1
        results.append({
            'word': word,
            'pos': best['pos'],
            'senseIndex': best['senseIndex'],
            'gloss': best['gloss'],
            'term': best['term'],
            'terms': terms_of(best['gloss']),
            'support': len(best['hits']),
            'occurrences': best['occurrences'],
            'capitalized': capital,
            'lift': best['lift'],
            'examples': examples,
            'ipa': entry['ipa'][:1],
            'cefr': cefr.get((word, best['pos'])),
            'wordnet': {
                'senses': len(wn),
                'lexfile': first['lexfile'] if first else None,
                'definition': first['definition'] if first else None,
                'hypernyms': chain,
                'topics': [wn_synsets[t]['members'][0] for t in (first['topic'] if first else []) if t in wn_synsets
                           and wn_synsets[t]['members']],
                'allLexfiles': sorted({wn_synsets[s]['lexfile'] for s in wn if s in wn_synsets}),
            },
        })
    results.sort(key=lambda r: r['word'])
    Path(out_path).write_text(json.dumps({'snapshot': lock['snapshot'], 'cards': results}, ensure_ascii=False, indent=0),
                              encoding='utf-8')
    print('aligned', len(results), Counter(r['pos'] for r in results).most_common())


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
