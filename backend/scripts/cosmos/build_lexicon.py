"""Echo Neural Cosmos — the shared, verified lexical graph (owner brief 2026-11-13).

Deterministic, offline, licence-checked. No model, no embedding, no AI: every relation in the output is one that Open English
WordNet 2025 (CC BY 4.0) states between two specific senses / synsets. Nothing is inferred from co-occurrence or similarity.

Scope (what a learner of this product can meet): every word of the SYSTEM decks (backend/src/main/resources/data/decks) and the
approved King lexicon; for those lemmas, ALL their OEWN senses (senses are never merged: bank = 10+ distinct senses), plus the
hypernym ancestors (≤ 3 steps) used to name groups, plus one-step neighbours that are themselves EN–VI dictionary headwords
(the "frontier": words the learner could learn next).

Output: frontend/public/cosmos/lexicon-<sha12>.json (content-hashed, immutable) + frontend/src/lib/cosmos/lexiconAsset.ts.

Usage: python build_lexicon.py <dir containing english-wordnet-2025.xml.gz>
"""
import glob
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1].parent
RES = ROOT / 'backend/src/main/resources'
OEWN_SHA256 = '9ca6d1dcb75f822fdd66617f7d9da48142ace38dd544d6ad5e2feca1674ad3fe'  # = backend/scripts/flashcards/vocabulary/sources.lock.json
OUT_DIR = ROOT / 'frontend/public/cosmos'
TS_OUT = ROOT / 'frontend/src/lib/cosmos/lexiconAsset.ts'
VERSION = 2
POS = {'n': 'n', 'v': 'v', 'a': 'a', 's': 'a', 'r': 'r'}  # adjective satellites are adjectives for learners
# Synset relations kept (and their direction in the file: [code, a, b] reads "a <code> b").
SYN_REL = {'hypernym': 'H', 'instance_hypernym': 'I', 'holo_part': 'P', 'mero_part': 'M', 'similar': 'R'}  # see the direction notes below
SENSE_REL = {'antonym': 'A', 'derivation': 'D'}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def scope_words():
    words = set()
    for f in sorted(glob.glob(str(RES / 'data/decks/*.json'))):
        for w in json.load(open(f, encoding='utf-8'))['words']:
            words.add(w['word'].strip().lower())
    raw = gzip.open(RES / 'data/king/corpus/king-core.sqlite.gz').read()
    p = os.path.join(tempfile.gettempdir(), 'cosmos-king-core.sqlite')
    open(p, 'wb').write(raw)
    con = sqlite3.connect(p)
    words |= {w.strip().lower() for (w,) in con.execute('select word from lexicon') if w and w.strip()}
    con.close()
    return words


def dictionary_headwords():
    con = sqlite3.connect(f"file:{RES / 'lexical/dictionary_en_vi.db'}?mode=ro", uri=True)
    out = {w for (w,) in con.execute('select word from words') if w and w == w.lower()}
    con.close()
    return out


def parse(oewn):
    entries = {}   # lemma -> [(sense_id, synset_id, pos)] in OEWN order
    entry_lemma = {}  # LexicalEntry id -> lemma (Synset@members lists entry ids)
    sense_rel = []  # (code, sense_a, sense_b)
    synsets = {}   # id -> dict
    with gzip.open(oewn, 'rb') as f:
        for _, el in ET.iterparse(f, events=('end',)):
            if el.tag == 'LexicalEntry':
                lem = el.find('Lemma')
                word, pos = lem.get('writtenForm'), POS.get(lem.get('partOfSpeech'))
                if word and pos:
                    entry_lemma[el.get('id')] = word.lower()
                    for s in el.findall('Sense'):
                        entries.setdefault(word.lower(), []).append((s.get('id'), s.get('synset'), pos))
                        for r in s.findall('SenseRelation'):
                            code = SENSE_REL.get(r.get('relType'))
                            if code:
                                sense_rel.append((code, s.get('id'), r.get('target')))
                el.clear()
            elif el.tag == 'Synset':
                d = el.find('Definition')
                synsets[el.get('id')] = {
                    'pos': POS.get(el.get('partOfSpeech'), 'n'),
                    'lexfile': el.get('lexfile') or '',
                    'gloss': ' '.join((d.text or '').split()) if d is not None else '',
                    'members': (el.get('members') or '').split(),
                    'rel': [(SYN_REL[r.get('relType')], r.get('target')) for r in el.findall('SynsetRelation')
                            if r.get('relType') in SYN_REL],
                }
                el.clear()
    return entries, sense_rel, synsets, entry_lemma


def main(cache_dir):
    oewn = Path(cache_dir) / 'english-wordnet-2025.xml.gz'
    if sha256(oewn) != OEWN_SHA256:
        raise SystemExit('OEWN hash mismatch — refusing to build from an unverified file')
    entries, sense_rel, synsets, entry_lemma = parse(oewn)
    heads = dictionary_headwords()
    core = {w for w in scope_words() if w in entries}

    # Senses of core lemmas; their synsets.
    sense_of = {}  # sense id -> (lemma, synset, pos)
    for lemma, senses in entries.items():
        for sid, syn, pos in senses:
            sense_of[sid] = (lemma, syn, pos)
    core_syn = {syn for w in core for _, syn, _ in entries[w]}

    # Frontier: one-step neighbours that are dictionary headwords, reached through a relation that teaches something about the
    # core word: shared synset (synonym), its more general concept, its whole / parts, its antonym, its derivations. Hyponym
    # lists (every dog breed under "dog") are NOT pulled in. Only the linking sense of a frontier lemma is kept.
    parents, children_rel = {}, []
    for sid, d in synsets.items():
        for code, target in d['rel']:
            children_rel.append((code, sid, target))
            if code in ('H', 'I'):
                parents.setdefault(sid, []).append(target)
    sense_by_syn = {}
    for lemma, senses in entries.items():
        for sid, syn, pos in senses:
            sense_by_syn.setdefault(syn, []).append(sid)
    keep = {sid for w in core for sid, _, _ in entries[w]}
    def take(sid):
        l = sense_of.get(sid, (None,))[0]
        if l and l not in core and l in heads and ' ' not in l:
            keep.add(sid)
    for syn in core_syn:
        for sid in sense_by_syn.get(syn, []):
            take(sid)
    for code, a, b in children_rel:
        linked = []
        if code in ('H', 'I') and a in core_syn:
            linked.append(b)               # the core synset's more general concept
        if code in ('P', 'M', 'R') and (a in core_syn or b in core_syn):
            linked.extend([a, b])          # wholes and parts; adjective clusters (similar to)
        for syn in linked:
            for sid in sense_by_syn.get(syn, []):
                take(sid)
    for code, sa, sb in sense_rel:
        if sense_of.get(sa, (None,))[0] in core:
            take(sb)
        if sense_of.get(sb, (None,))[0] in core:
            take(sa)
    frontier = {sense_of[sid][0] for sid in keep} - core

    lemmas = sorted(core | frontier)
    lemma_idx = {l: i for i, l in enumerate(lemmas)}
    kept_senses = [(sid, *sense_of[sid]) for l in lemmas for sid, _, _ in entries[l] if sid in keep]
    member_syn = {syn for _, _, syn, _ in kept_senses}

    # Ancestors (≤ 3 hypernym steps) of member synsets: names for groups; their glosses explain them.
    syn_keep = set(member_syn)
    frontier_syn = set(core_syn)
    for _ in range(3):
        nxt = set()
        for s in frontier_syn:
            nxt.update(parents.get(s, []))
        nxt -= syn_keep
        syn_keep |= nxt
        frontier_syn = nxt
    syn_list = sorted(syn_keep)
    syn_idx = {s: i for i, s in enumerate(syn_list)}
    lexfiles = sorted({synsets[s]['lexfile'] for s in syn_list})
    lf_idx = {l: i for i, l in enumerate(lexfiles)}

    sense_idx = {}
    senses_out = []
    for sid, lemma, syn, pos in kept_senses:
        sense_idx[sid] = len(senses_out)
        senses_out.append([lemma_idx[lemma], syn_idx[syn]])

    syn_out = []
    for s in syn_list:
        d = synsets[s]
        # A name for an ancestor that has no kept member: its first OEWN member lemma (label only, never a learner star).
        name = ''
        if s not in member_syn:
            m = d['members'][0] if d['members'] else ''
            name = entry_lemma.get(m, '')
        syn_out.append([d['pos'], lf_idx[d['lexfile']], d['gloss'], name])

    rel_out = []
    for code, a, b in children_rel:
        if a in syn_idx and b in syn_idx:
            # OEWN "a hypernym b" = b is the more general concept of a. Stored as [code, general, specific] / [P, whole, part].
            if code in ('H', 'I'):
                rel_out.append([code, syn_idx[b], syn_idx[a]])
            elif code == 'P':  # a holo_part b: b is the whole that a is a part of (checked: wheel holo_part -> wheeled vehicle)
                rel_out.append(['P', syn_idx[b], syn_idx[a]])
            elif code == 'M':  # a mero_part b: b is a part of a (checked: car mero_part -> its parts)
                rel_out.append(['P', syn_idx[a], syn_idx[b]])
            elif code == 'R':  # adjective "similar to": a satellite and its head adjective (symmetric, stored once)
                rel_out.append(['R', min(syn_idx[a], syn_idx[b]), max(syn_idx[a], syn_idx[b])])
    rel_out = sorted({tuple(r) for r in rel_out})
    rel_out = [list(r) for r in rel_out]
    sense_rel_out = sorted({(c, min(sense_idx[a], sense_idx[b]), max(sense_idx[a], sense_idx[b]))
                            for c, a, b in sense_rel if a in sense_idx and b in sense_idx})

    doc = {
        'v': VERSION,
        'source': 'Open English WordNet 2025 (en-word.net), CC BY 4.0',
        'sourceSha256': OEWN_SHA256,
        'relations': {
            'S': 'two lemmas share one synset (synonyms in that sense)',
            'A': 'sense antonym', 'D': 'derivationally related senses',
            'H': '[H, general, specific] hypernym', 'I': '[I, class, instance] instance hypernym',
            'P': '[P, whole, part] part meronymy',
            'R': '[R, a, b] adjective similar-to (head adjective and its satellite, symmetric)',
        },
        'core': sorted(lemma_idx[w] for w in core),
        'lemmas': lemmas,
        'lexfiles': lexfiles,
        'senses': senses_out,
        'synsets': syn_out,
        'synRel': rel_out,
        'senseRel': [list(x) for x in sense_rel_out],
    }
    data = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    digest = hashlib.sha256(data).hexdigest()[:12]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob('lexicon-*.json'):
        pass  # older names stay: open pages may still hold them (immutable caching)
    name = f'lexicon-{digest}.json'
    (OUT_DIR / name).write_bytes(data)
    TS_OUT.parent.mkdir(parents=True, exist_ok=True)
    TS_OUT.write_text(
        '// Generated by backend/scripts/cosmos/build_lexicon.py — do not edit. Content-hashed: a changed graph ships under a new name.\n'
        f"export const COSMOS_LEXICON_URL = '/cosmos/{name}';\n"
        f"export const COSMOS_LEXICON_VERSION = 'oewn2025-v{VERSION}-{digest}';\n",
        encoding='utf-8', newline='\n')
    print(f'core {len(core)} frontier {len(frontier)} lemmas {len(lemmas)} senses {len(senses_out)} synsets {len(syn_out)} '
          f'synRel {len(rel_out)} senseRel {len(sense_rel_out)} bytes {len(data)} gz {len(gzip.compress(data))} -> {name}')


if __name__ == '__main__':
    main(sys.argv[1])
