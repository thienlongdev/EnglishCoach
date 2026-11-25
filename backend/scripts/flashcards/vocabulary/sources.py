"""Source loaders for the SYSTEM vocabulary library build (owner brief 2026-10-30).

Every source is read-only and licence-checked (see SOURCES.md):
- EN-VI SQLite (bundled `dictionary_en_vi.db`, CC BY-SA 4.0): Vietnamese senses by part of speech + IPA.
- Tatoeba English-Vietnamese pairs (CC BY 2.0 FR): human-written example sentences with their human Vietnamese translation.
- Open English WordNet 2025 (CC BY 4.0): part of speech, sense order, lexicographer file, hypernyms (topic evidence).
- CEFR-J Vocabulary Profile 1.5 (free incl. commercial, citation) + Octanove C1/C2 1.0 (CC BY-SA 4.0): CEFR levels.
"""
import bz2
import csv
import gzip
import hashlib
import json
import re
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SQLITE = ROOT / 'backend/src/main/resources/lexical/dictionary_en_vi.db'
LOCK = HERE / 'sources.lock.json'


def nfc(s):
    return unicodedata.normalize('NFC', s or '')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def verify(cache):
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    for s in lock['sources']:
        p = (cache / s['file']) if s['file'] != 'BUNDLED' else SQLITE
        got = sha256(p)
        if got != s['sha256']:
            raise SystemExit(f"source {s['id']} hash mismatch: {got}")
    return lock


SQLITE_POS = {'N': 'noun', 'noun': 'noun', 'V': 'verb', 'verb': 'verb', 'A': 'adjective', 'adj': 'adjective',
              'D': 'adverb', 'adv': 'adverb', 'P': 'pronoun', 'pron': 'pronoun', 'C': 'conjunction', 'E': 'preposition',
              'idiom': 'idiom'}


def load_sqlite():
    """word -> {'senses': [(pos, gloss)], 'ipa': [ipa...]} for lower-case English headwords."""
    con = sqlite3.connect(f'file:{SQLITE}?mode=ro', uri=True)
    out = {}
    q = ('select w.word, d.pos, d.definition from words w join word_definitions wd on wd.word_id = w.id '
         'join definitions d on d.id = wd.definition_id order by w.id, wd.id')
    for word, pos, gloss in con.execute(q):
        if not word or word != word.lower():
            continue
        p = SQLITE_POS.get(pos)
        if not p:
            continue
        out.setdefault(word, {'senses': [], 'ipa': []})['senses'].append((p, nfc(gloss).strip()))
    for word, ipa in con.execute('select w.word, p.ipa from pronunciations p join words w on w.id = p.word_id order by p.id'):
        if word in out and ipa:
            out[word]['ipa'].append(nfc(ipa).strip())
    return out


def load_tatoeba(cache):
    """[(eng_id, eng, vie_id, vie)] from the per-language exports."""
    vie = {}
    with bz2.open(cache / 'vie_sentences.tsv.bz2', 'rt', encoding='utf-8') as f:
        for line in f:
            p = line.rstrip('\n').split('\t')
            vie[p[0]] = nfc(p[2])
    links = []
    with bz2.open(cache / 'vie-eng_links.tsv.bz2', 'rt', encoding='utf-8') as f:
        for line in f:
            a, b = line.rstrip('\n').split('\t')
            links.append((a, b))
    need = {b for _, b in links}
    eng = {}
    with bz2.open(cache / 'eng_sentences.tsv.bz2', 'rt', encoding='utf-8') as f:
        for line in f:
            p = line.rstrip('\n').split('\t')
            if p[0] in need:
                eng[p[0]] = nfc(p[2])
    return [(b, eng[b], a, vie[a]) for a, b in links if a in vie and b in eng]


CEFR_POS = {'noun': 'noun', 'verb': 'verb', 'adjective': 'adjective', 'adverb': 'adverb', 'pronoun': 'pronoun',
            'preposition': 'preposition', 'conjunction': 'conjunction', 'determiner': 'determiner'}
LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']


def load_cefr(cache):
    """(word, pos) -> lowest listed CEFR level; slash variants become separate keys."""
    out = {}
    for name in ('cefrj-vocabulary.csv', 'octanove-c1c2.csv'):
        with open(cache / name, encoding='utf-8') as f:
            for row in csv.DictReader(f):
                pos = CEFR_POS.get((row.get('pos') or '').strip())
                level = (row.get('CEFR') or '').strip()
                if not pos or level not in LEVEL_ORDER:
                    continue
                for hw in (row.get('headword') or '').split('/'):
                    hw = hw.strip().lower()
                    if not hw:
                        continue
                    key = (hw, pos)
                    if key not in out or LEVEL_ORDER.index(level) < LEVEL_ORDER.index(out[key]):
                        out[key] = level
    return out


WN_POS = {'n': 'noun', 'v': 'verb', 'a': 'adjective', 's': 'adjective', 'r': 'adverb'}


def load_wordnet(cache):
    """lemma -> {pos: [synset ids in sense order]}, synset -> {lexfile, hypernyms, words, definition}."""
    lemmas, synsets = {}, {}
    with gzip.open(cache / 'english-wordnet-2025.xml.gz', 'rb') as f:
        for _, el in ET.iterparse(f, events=('end',)):
            tag = el.tag
            if tag == 'LexicalEntry':
                lem = el.find('Lemma')
                word = lem.get('writtenForm')
                pos = WN_POS.get(lem.get('partOfSpeech'))
                if word and pos:
                    ids = [s.get('synset') for s in el.findall('Sense')]
                    lemmas.setdefault(word.lower(), {}).setdefault(pos, []).extend(ids)
                el.clear()
            elif tag == 'Synset':
                rel = el.findall('SynsetRelation')
                d = el.find('Definition')
                synsets[el.get('id')] = {
                    'lexfile': el.get('lexfile'),
                    'hyper': [r.get('target') for r in rel if r.get('relType') in ('hypernym', 'instance_hypernym')],
                    'topic': [r.get('target') for r in rel if r.get('relType') == 'domain_topic'],
                    'members': (el.get('members') or '').split(),
                    'definition': d.text if d is not None else '',
                }
                el.clear()
    return lemmas, synsets


TOKEN = re.compile(r"[a-z]+(?:['’-][a-z]+)*")


def tokens(text):
    return TOKEN.findall(text.lower().replace('’', "'"))
