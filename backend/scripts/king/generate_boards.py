"""Offline-only board generation/verification against read-only canonical SQLite.

No runtime imports, network, application DB, or dictionary copy in the output.
"""
import hashlib
import json
import random
import re
import sqlite3
import sys
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / 'backend/src/main/resources/data/king/conquest-engineering.json'
POS = {'N', 'V', 'A', 'D', 'C', 'P', 'E', 'noun', 'verb', 'adj', 'adv', 'pron', 'n'}
PROPER = re.compile(r'^(thủ đô|thành phố|tỉnh của|tên riêng|danh từ riêng|tên (người|nước|một|gọi)|chòm sao|thần |nữ thần )')
GRAMMAR = re.compile(r'^(nội động từ|ngoại động từ|danh từ|động từ|tính từ|trạng từ|liên từ|giới từ)\.?$', re.I)
COMMON = set('cat dog tea eat ate hat hot hit sit sat rat art red read dear dare garden water rain train tree green great greet stone tone note ten net nest test set sea seat east meat team mate tame steam star start tar car care race rice nice ice line lion oil tin time tire fire fine find kind king ring bring bird big bed bee see seed need door room moon soon son sun run fun fan can pan pen pin pit tip top pot stop shop ship fish dish wish win wind mind mine more core score sore rose nose one not nor or ore ant tan tap pat part park pair hair air fair far fat fit flat last list lost lot let late tale tile tail light night right tight sight might eight weight wait paint point port sport sort short shirt earth heart heat tear rate rest near ear earn learn year yard hard hand sand land stand sat sad day dry sky fly cry try fry buy boy toy joy may ray way pay play stay say lay bay bad bag rag age ago ego leg log fog frog free feed feel feet file life leaf field lie pie pet get wet jet met men man map nap gap cap cup cut cot cost coat cast coast boat boot book cook took look lock rock back black block neck deck desk duck luck truck track pack lack rack tack cake make take bake lake like bike hike kite site tie eye die dye toe tie rid ride side wide wild mild milk silk sick pick pink link sink drink think thank thick thin this that the there their those these then when where what with wife wire wise wall ball tall call fall mall small smell sell tell well bell belt melt felt left lift gift soft loft leaf road load goal gold sold cold hold fold old bold door floor foot food good wood wool pool tool cool coal hole pole role roll doll toll hill fill pill bill still till ill all ale male meal heal deal real seal sail mail main pain gain again grain drain brain plain plan plane plant plate place peace pace space spare pear bear bare bar barn arm ram ham harm farm form from fork for fort four fur firm turn burn born torn corn horn worn word work world worm warm war wash cash catch match watch patch batch bath path math map mat mad dam pad lap clap lap lip dip rip trip grip drip drop crop rope hope hop pop cop crop cream dream dear bread bean bead beat bear beer deer deep keep sheep sleep steep step stem temp camp lamp limp lump pump jump dump damp bend send tend tent rent lent went cent cell yell yellow low slow flow blow snow show grow row bow cow now how down town brown crown clown cloud round sound bound pound found ground around proud route rain raise rise rose rest crest chest quest quip quit quite quiet queen quick'.split())


def corpus():
    path = ROOT / 'backend/src/main/resources/lexical/dictionary_en_vi.db'
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        rows = db.execute('SELECT w.word,d.pos,d.sub_pos,d.definition FROM words w JOIN word_definitions wd ON wd.word_id=w.id JOIN definitions d ON wd.definition_id=d.id WHERE length(w.word) BETWEEN 3 AND 8 ORDER BY w.word,d.id')
        words, banned = set(), set()
        for word, pos, sub, meaning in rows:
            if not re.fullmatch('[a-z]{3,8}', word):
                continue
            meta = f'{pos or ""} {sub or ""}'.lower()
            if re.search('proper|riêng', meta) or PROPER.match((meaning or '').strip().lower()):
                banned.add(word)
            if pos in POS and meaning and meaning.strip() and not GRAMMAR.fullmatch(meaning.strip()):
                words.add(word)
    return words - banned


NEIGHBOURS = {i: [j for j in range(25) if j != i and max(abs(i//5-j//5), abs(i%5-j%5)) == 1] for i in range(25)}


def trie(words):
    root = {}
    for word in sorted(words):
        node = root
        for letter in word:
            node = node.setdefault(letter, {})
        node['$'] = word
    return root


def solve(letters, root):
    paths = {}

    def visit(tile, node, path, used):
        next_node = node.get(letters[tile].lower())
        if next_node is None:
            return
        path = path + (tile,)
        if '$' in next_node:
            word = next_node['$']
            previous = paths.get(word)
            if previous is None or (12 in path and 12 not in previous):
                paths[word] = path
        if len(path) == 8:
            return
        for adjacent in NEIGHBOURS[tile]:
            if not used & (1 << adjacent):
                visit(adjacent, next_node, path, used | (1 << adjacent))

    for cell in range(25):
        visit(cell, root, (), 1 << cell)
    return paths


def metrics(paths):
    coverage = [sum(cell in path for path in paths.values()) for cell in range(25)]
    return dict(playableWords=len(paths), shortWords=sum(3 <= len(w) <= 4 for w in paths),
                longWords=sum(len(w) >= 5 for w in paths), throneWords=sum(12 in p for p in paths.values()),
                minCellCoverage=min(coverage), cellCoverage=coverage)


def quality(m, paths):
    return (m['playableWords'] >= 50 and m['shortWords'] >= 20 and m['longWords'] >= 8
            and m['throneWords'] >= 8 and m['minCellCoverage'] >= 2
            and len(set(paths) & COMMON) >= 24)


def fingerprint(board):
    fields = [board['id'], ''.join(board['letters']), str(board['seed']),
              board['sourceKind'], board['sourceRef'], board['contentVersion'],
              json.dumps(board['qualityMetrics'], separators=(',', ':')),
              '|'.join(c['word'] + ':' + ','.join(map(str, c['path'])) for c in board['echoCandidates'])]
    return hashlib.sha256('|'.join(fields).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--count', type=int, default=20)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--memory-fixture', action='store_true')
    parser.add_argument('--memory-out', type=Path, default=ROOT/'docs/king-of-english/phase3/board-memory-words.json')
    args = parser.parse_args()
    words = corpus()
    root = trie(words)
    if '--verify' in sys.argv:
        boards = json.loads(OUTPUT.read_text(encoding='utf-8'))
        for b in boards:
            paths = solve(b['letters'], root)
            assert metrics(paths) == b['qualityMetrics'], b['id']
            assert quality(metrics(paths), paths), b['id']
            assert fingerprint(b) == b['fingerprint'], b['id']
            for candidate in b['echoCandidates']:
                assert candidate['word'] in paths
                assert ''.join(b['letters'][c].lower() for c in candidate['path']) == candidate['word']
        assert len({''.join(b['letters']) for b in boards}) == len(boards)
        assert not quality(metrics(solve(['Z'] * 25, root)), {}), 'dead board must fail'
        print(json.dumps(dict(boards=len(boards), solver='PASS', deadBoard='REJECTED', canonicalEligibleWords=len(words), humanApproved=0)))
        return
    if args.memory_fixture:
        boards=json.loads(OUTPUT.read_text(encoding='utf-8'))
        data={b['id']:sorted(solve(b['letters'],root))[:min(170,b['qualityMetrics']['playableWords'])] for b in boards}
        target=args.memory_out
        target.write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(dict(memoryFixtureBoards=len(data),minValidUsedWords=min(map(len,data.values())))))
        return
    # Preserve existing IDs, seeds and fingerprints. Expand; never rewrite a review.
    boards = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else []
    if args.count < len(boards):
        raise ValueError('Cannot shrink existing engineering bank')
    layouts = {''.join(b['letters']) for b in boards}
    if len(boards) == args.count:
        print(json.dumps(dict(boards=len(boards), unchanged=True)))
        return
    weighted = 'AAAAAAAEEEEEEEEEEIIIIIOOOOOUUUUUNNNNNRRRRRRSSSSSSTTTTTTLLLLDDDDGGCCMMBBPPHHFFWWYYVK'
    for seed in range(3000, 6000):
        rng = random.Random(seed)
        letters = [rng.choice(weighted) for _ in range(25)]
        if ''.join(letters) in layouts:
            continue
        paths = solve(letters, root)
        m = metrics(paths)
        if not quality(m, paths) or m['playableWords'] < 150:
            continue
        # Small common-word policy pool; long/short/throne/regions all retained.
        candidates = sorted(set(paths) & COMMON, key=lambda w: (12 not in paths[w], -len(w), w))[:32]
        b = dict(id=f'king-c-{len(boards)+1}', letters=letters, seed=seed, qualityMetrics=m,
                 echoCandidates=[dict(word=w, path=list(paths[w])) for w in candidates],
                 sourceKind='OFFLINE_GENERATED_ENGINEERING_BOARD', sourceRef=f'king-phase3-offline:seed-{seed}',
                 contentVersion='3.0.0', reviewStatus='AUTO_VALIDATED', humanReview=None, fingerprint='')
        b['fingerprint'] = fingerprint(b)
        boards.append(b)
        layouts.add(''.join(letters))
        if len(boards) == args.count:
            break
    assert len(boards) == args.count, f'Only {len(boards)} qualified boards; do not pad'
    OUTPUT.write_text(json.dumps(boards, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(boards=len(boards), canonicalEligibleWords=len(words), humanApproved=0,
                         minPlayable=min(b['qualityMetrics']['playableWords'] for b in boards))))


if __name__ == '__main__':
    main()
