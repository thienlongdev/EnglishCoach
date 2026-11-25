"""Step 3 — build the SYSTEM topic deck files and the quality gate (owner brief 2026-10-30).

Reads the aligned cards and the editorial membership (`topics.json`), applies the publication gate and writes:
- backend/src/main/resources/data/decks/<slug>.json  (VocabDeckSeeder format + `examples_vi`, `pos`, `source`)
- docs/flashcards/vocabulary-universe-2026-10-30/manifest.json  (per card provenance, gate result, counts)

A card is published only when EVERY mandatory check passes; otherwise it is listed in the manifest with its reason.

usage: python build.py <aligned.json>
"""
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

from classify import SENSITIVE

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DECK_DIR = ROOT / 'backend/src/main/resources/data/decks'
EVIDENCE = ROOT / 'docs/flashcards/vocabulary-universe-2026-10-30'
CATEGORY = 'TOPIC'

IPA_OK = re.compile(r"^/[a-zæɑɒɔəɜɪʊʌθðʃʒŋɡːˈˌ.()ɛɐɚɝʔɾɹɫ̃ʍʰ‿ ]+/$")
VOWELS = 'aeiouæɑɒɔəɜɪʊʌɛɐɚɝ'
ESPEAK_STRESS = re.compile(r'[bcdfghjklmnpqrstvwxzθðʃʒŋɡɹ][ˈˌ][' + VOWELS + ']')


def nfc(s):
    return unicodedata.normalize('NFC', s or '')


def syllables(t):
    return len(t.split())


AGENT = re.compile(r'(er|or|ist|ian|ant|ent|man|ee|ess)$')
AGENT_HEADS = ('người', 'nhà', 'khách', 'thợ', 'kẻ')


def meaning_of(card):
    """The attested wording first, then up to two further wordings of the SAME dictionary sense."""
    term = card['term']
    if card['pos'] == 'noun' and AGENT.search(card['word']):
        # "composer": the translator's "soạn nhạc" belongs to the sense wording "nhà soạn nhạc"
        for t in card['terms']:
            if t.endswith(' ' + term) and t.split()[0] in AGENT_HEADS and syllables(t) <= 4:
                term = t
                break
    out = [term]
    for t in card['terms']:
        if len(out) >= 3:
            break
        if t in out or term in t or syllables(t) > 3 or re.search(r'[()\[\]"0-9]', t):
            continue
        # a further wording is shown only when it is a sibling form of the attested one (shares a syllable):
        # "bánh quy, bích quy", "đồ ăn, thức ăn"; unrelated or archaic dictionary wordings stay out
        if not set(t.split()) & set(term.split()):
            continue
        out.append(t)
    text = ', '.join(out).replace('&', 'và')
    return text[:1].upper() + text[1:]


def ipa_of(card):
    for ipa in card['ipa']:
        ipa = nfc(ipa).strip()
        if not ipa.startswith('/'):
            ipa = '/' + ipa.strip('[]/') + '/'
        if IPA_OK.match(ipa) and not ESPEAK_STRESS.search(ipa) and len(ipa) <= 40:
            return ipa
    return None


def gate(card, word):
    reasons = []
    if not word or word != word.strip().lower():
        reasons.append('word-format')
    if not card['examples']:
        reasons.append('no-example')
    else:
        ex = card['examples'][0]
        en, vi = ex['en'], ex['vi']
        if '&' in en or '&' in vi:
            reasons.append('ampersand-in-example')
        if len(en.split()) > 22:
            reasons.append('example-too-long')
        if SENSITIVE.search(en) and not SENSITIVE.search(word):
            reasons.append('sensitive-example')
        if f" {card['term']} " not in ' ' + re.sub(r'[^\w\s]', ' ', vi.lower()) + ' ':
            reasons.append('translation-lacks-meaning')
        if not vi.strip() or not en.strip():
            reasons.append('empty-example')
    if card['term'] in ('', None):
        reasons.append('no-meaning')
    return reasons


def norm(t):
    return re.sub(r'\s+', ' ', nfc(t).lower()).strip()


def checked_wording(word, card, wording, glosses):
    """A reviewed headline is accepted only with dictionary evidence for every part, inside the attested sense."""
    parts = [norm(p) for p in wording.split(',') if p.strip()]
    translations = ' | '.join(' ' + re.sub(r'[^\w\s]', ' ', norm(e['vi'])) + ' ' for e in card['examples'])
    everything = ' | '.join(norm(g) for _, g in glosses) + ' | ' + re.sub(r'\s+', ' ', translations)
    same_sense = norm(card['gloss'])
    missing = [p for p in parts if p not in everything and f' {p} ' not in everything]
    if missing:
        return None, f'unattested: {missing}'
    if card['term'] not in parts[0] and parts[0] not in same_sense:
        return None, 'first part is outside the attested sense'
    return wording, None


def main(aligned_path):
    import sources
    aligned = {c['word']: c for c in json.loads(Path(aligned_path).read_text(encoding='utf-8'))['cards']}
    review = json.loads((HERE / 'review.json').read_text(encoding='utf-8'))
    lex = sources.load_sqlite()
    review_problems = []
    topics = json.loads((HERE / 'topics.json').read_text(encoding='utf-8'))['decks']
    seen, manifest_cards, rejected, decks_out = {}, [], [], []
    for deck in topics:
        words = [w.strip() for w in deck['words'].split(',') if w.strip()]
        published = []
        for w in words:
            if w in seen:
                raise SystemExit(f'{w} is listed in {seen[w]} and {deck["slug"]}')
            seen[w] = deck['slug']
            card = aligned.get(w)
            if not card:
                rejected.append({'word': w, 'deck': deck['slug'], 'reasons': ['not-aligned']})
                continue
            reasons = gate(card, w)
            if w in review['remove']:
                reasons.append('editorial: ' + review['remove'][w])
            if reasons:
                rejected.append({'word': w, 'deck': deck['slug'], 'reasons': reasons})
                continue
            examples = [e for e in card['examples'] if not gate({**card, 'examples': [e]}, w)][:2]
            meaning = meaning_of(card)
            if w in review['wording']:
                accepted, problem = checked_wording(w, card, review['wording'][w], lex[w]['senses'])
                if accepted:
                    meaning = accepted
                else:
                    review_problems.append(f'{w}: {problem}')
            wn = card['wordnet']
            definition = wn['definition'] if wn['senses'] == 1 and wn['definition'] else None
            entry = {
                'word': w,
                'pos': card['pos'],
                'ipa': ipa_of(card),
                'cefr': card['cefr'],
                'general_translation_vi': meaning,
                'meanings': [definition[:1].upper() + definition[1:] + ('' if definition.endswith('.') else '.')]
                if definition else [],
                'examples': [e['en'] for e in examples],
                'examples_vi': [e['vi'] for e in examples],
                'source': {
                    'meaning': f"en-vi-sqlite sense #{card['senseIndex'] + 1} ({card['pos']})",
                    'attestedWording': card['term'],
                    'support': card['support'],
                    'tatoeba': [[e['enId'], e['viId']] for e in examples],
                    'definition': 'oewn-2025 (monosemous)' if definition else None,
                    'cefr': 'cefr-j/octanove' if card['cefr'] else None,
                },
            }
            published.append(entry)
            manifest_cards.append({'deck': deck['slug'], **{k: entry[k] for k in ('word', 'pos', 'ipa', 'cefr')},
                                   'meaning': entry['general_translation_vi'], 'source': entry['source']})
        out = {
            'slug': deck['slug'], 'title': deck['title'], 'description': deck['description'], 'category': CATEGORY,
            'themeColor': deck['themeColor'], 'icon': deck['icon'], 'sortOrder': deck['sortOrder'], 'curated': True,
            'words': published,
        }
        for field in ('title', 'description'):
            if '&' in out[field]:
                raise SystemExit(f'"&" in {deck["slug"]} {field}')
        decks_out.append(out)
    for out in decks_out:
        (DECK_DIR / f"{out['slug']}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n',
                                                      encoding='utf-8', newline='\n')
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    counts = {d['slug']: len(d['words']) for d in decks_out}
    summary = {
        'snapshot': '2026-10-30',
        'decks': counts,
        'published': sum(counts.values()),
        'rejected': len(rejected),
        'rejectedReasons': Counter(r for x in rejected for r in x['reasons']),
        'withIpa': sum(1 for c in manifest_cards if c['ipa']),
        'withCefr': sum(1 for c in manifest_cards if c['cefr']),
        'cefr': Counter(c['cefr'] for c in manifest_cards if c['cefr']),
    }
    (EVIDENCE / 'manifest.json').write_text(json.dumps({'summary': summary, 'cards': manifest_cards, 'rejected': rejected},
                                                       ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print('review wordings refused:', len(review_problems))
    for p in review_problems:
        print('  ', p)


if __name__ == '__main__':
    main(sys.argv[1])
