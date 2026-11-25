"""Soán ngôi word list: every inflected form of the locked SCOWL US + GB speller dictionaries.

The King corpus lexicon holds lemmas only (no pronouns, no "posts" / "ran" / "her"). Soán ngôi accepts any ordinary English
word, so this script expands the two locked Hunspell dictionaries (prefix / suffix rules of their own .aff files) into a
plain list of 3-8 letter lowercase words. Excluded: capitalised entries (proper names), entries the dictionary marks
NOSUGGEST (offensive words), compound-only fragments, strings without a vowel, a short list of abbreviations SCOWL keeps
in lowercase and the same profanity filter as build_boards.py. Output: backend/src/main/resources/data/king/
conquest-lexicon.txt.gz (one word per line, sorted) + an evidence summary. Usage:
    python build_conquest_lexicon.py <dir with scowl-us.zip and scowl-gb.zip>
"""
import gzip
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / 'src/main/resources/data/king/conquest-lexicon.txt.gz'
EVIDENCE = ROOT.parent / 'docs/king-of-english/throne-conquest-2026-10-29/lexicon-build.json'
WORD = re.compile('[a-z]{3,8}')
PROFANITY = re.compile('fuck|shit|nigger|sexual|suicide|rape|murder|cunt|whore|slut|bitch|porn')
DENY = {'sex', 'penis', 'vagina', 'semen', 'cock', 'dick', 'ass', 'arse', 'tit', 'tits', 'twat', 'wank', 'piss',
        # Abbreviations the speller keeps in lowercase (not words a learner builds).
        'etc', 'approx', 'dept', 'govt', 'misc', 'ibid', 'viz', 'asap', 'aka', 'fyi', 'tbsp', 'tsp', 'abbr', 'esp',
        'est', 'inc', 'yrs', 'hrs', 'mins', 'secs', 'pkg', 'qty', 'avg', 'bldg', 'blvd', 'corp', 'univ', 'vols',
        'eds', 'resp', 'sept', 'acct', 'adj', 'adv', 'advt', 'amt', 'ans', 'arr', 'assn', 'assoc', 'asst', 'attn',
        'atty', 'aux', 'avdp', 'ave', 'bbl', 'bdrm', 'biog', 'biol', 'bxs', 'capt', 'chg', 'chge', 'chm', 'cir',
        'cit', 'coll', 'comm', 'cont', 'contd', 'corr', 'cpd', 'cpl', 'cps', 'ctn', 'ctr', 'cwt', 'dbl', 'deg',
        'diam', 'dict', 'dist', 'div', 'dob', 'doz', 'dpi', 'dpt', 'eccl', 'ecol', 'econ', 'educ', 'elem', 'emf',
        'enc', 'encl', 'ency', 'equiv', 'excl', 'exp', 'ext', 'fem', 'flt', 'fol', 'foll', 'fps', 'freq', 'furn',
        'fwd', 'fwy', 'fut', 'geog', 'geom', 'gov', 'hdqrs', 'hgt', 'hgwy', 'hist', 'hosp', 'hwy', 'idem', 'incl',
        'ind', 'inf', 'ins', 'inst', 'instr', 'int', 'ioctl', 'isl', 'ital', 'jct', 'jun', 'lat', 'lav', 'lbw', 'lib',
        'liq', 'ltd', 'masc', 'mdse', 'meas', 'med', 'mfg', 'mgr', 'mks', 'mpg', 'mtg', 'mtge', 'natl', 'neg',
        'neut', 'obj', 'obs', 'opp', 'org', 'orig', 'pkt', 'pkwy', 'ppm', 'ppr', 'pref', 'pres', 'prev', 'pvt',
        'ques', 'rcpt', 'rec', 'recd', 'reg', 'regex', 'rel', 'rem', 'rep', 'res', 'rev', 'riv', 'rps', 'rte',
        'sch', 'sci', 'sec', 'secy', 'sen', 'seq', 'shpt', 'soc', 'sqq', 'std', 'stdio', 'subj', 'suppl', 'supt',
        'syn', 'tel', 'terr', 'tnpk', 'treas', 'ttys', 'twp', 'uhf', 'ult', 'usu', 'val', 'vhf', 'vlf', 'wpm',
        'xor', 'xterm', 'warez', 'bogon', 'zorch', 'lidar', 'intel', 'com', 'con', 'cor', 'cos', 'def', 'emf',
        'mkay', 'lol', 'omg', 'btw', 'diy',
        # Slurs and explicit terms, whether or not the speller lists them.
        'negro', 'negros', 'negroes', 'fag', 'fags', 'faggot', 'wog', 'wogs', 'yid', 'yids', 'gyp', 'gyps', 'coon',
        'coons', 'spic', 'spics', 'chink', 'chinks', 'kike', 'kikes', 'dyke', 'dykes', 'retard', 'retards', 'spaz',
        'tranny', 'paki', 'pakis', 'gook', 'gooks', 'raper', 'rapers', 'nooky', 'pubes', 'cum', 'cums', 'tits',
        'boob', 'boobs', 'wanker', 'bugger', 'crap', 'crappy', 'damn', 'hell', 'bastard', 'arses', 'asses', 'dicks'}
# Roman numerals the speller lists ("xvii", "lxiv"); real words that happen to be numerals stay.
ROMAN = re.compile('m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})')
ROMAN_WORDS = {'mix', 'dix', 'mid', 'did', 'dim', 'lid', 'mil', 'civic', 'vivid', 'mild', 'mill', 'ill', 'cid'}


def locked(source_id):
    lock = json.loads((HERE / 'sources.lock.json').read_text(encoding='utf-8'))
    return next(s for s in lock['sources'] if s['id'] == source_id)


def read(archive_path, source_id):
    source = locked(source_id)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if digest != source['sha256']:
        raise SystemExit('CHECKSUM_MISMATCH:' + source_id)
    with zipfile.ZipFile(archive_path) as archive:
        dic = next(n for n in archive.namelist() if n.endswith('.dic'))
        aff = next(n for n in archive.namelist() if n.endswith('.aff'))
        return archive.read(aff).decode('utf-8'), archive.read(dic).decode('utf-8'), digest


def rules(aff):
    table = {}
    for line in aff.splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[0] not in ('PFX', 'SFX'):
            continue
        kind, flag = parts[0], parts[1]
        if flag not in table:  # header line: kind flag cross count
            table[flag] = dict(kind=kind, cross=parts[2] == 'Y', entries=[])
            continue
        strip = '' if parts[2] == '0' else parts[2]
        add = '' if parts[3] == '0' else parts[3].split('/')[0]
        condition = parts[4] if len(parts) > 4 else '.'
        pattern = re.compile(('^' + condition) if kind == 'PFX' else (condition + '$'))
        table[flag]['entries'].append((strip, add, pattern))
    return table


def apply(word, rule):
    out = []
    for strip, add, pattern in rule['entries']:
        if not pattern.search(word):
            continue
        if rule['kind'] == 'SFX':
            if strip and not word.endswith(strip):
                continue
            out.append(word[:len(word) - len(strip)] + add)
        else:
            if strip and not word.startswith(strip):
                continue
            out.append(add + word[len(strip):])
    return out


def expand(aff, dic):
    table = rules(aff)
    words = set()
    for line in dic.splitlines()[1:]:
        entry = line.strip()
        if not entry:
            continue
        stem, _, flags = entry.partition('/')
        if '!' in flags or 'c' in flags or not re.fullmatch('[a-z]+', stem):
            continue
        forms = {stem}
        suffixed = set()
        for flag in flags:
            rule = table.get(flag)
            if rule and rule['kind'] == 'SFX':
                for form in apply(stem, rule):
                    suffixed.add((form, rule['cross']))
        forms |= {form for form, _ in suffixed}
        for flag in flags:
            rule = table.get(flag)
            if rule and rule['kind'] == 'PFX':
                forms |= set(apply(stem, rule))
                if rule['cross']:
                    for form, cross in suffixed:
                        if cross:
                            forms |= set(apply(form, rule))
        words |= forms
    return words


def keep(word):
    return (WORD.fullmatch(word) and re.search('[aeiouy]', word) and not PROFANITY.search(word) and word not in DENY
            and (word in ROMAN_WORDS or not ROMAN.fullmatch(word)))


def main():
    folder = Path(sys.argv[1])
    us_aff, us_dic, us_hash = read(folder / 'scowl-us.zip', 'scowl-us')
    gb_aff, gb_dic, gb_hash = read(folder / 'scowl-gb.zip', 'scowl-gb')
    us, gb = expand(us_aff, us_dic), expand(gb_aff, gb_dic)
    words = sorted(w for w in us | gb if keep(w))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = ('\n'.join(words) + '\n').encode('ascii')
    with gzip.GzipFile(OUT, 'wb', mtime=0) as stream:
        stream.write(data)
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(dict(
        sources={'scowl-us': us_hash, 'scowl-gb': gb_hash}, words=len(words), usForms=len(us), gbForms=len(gb),
        lengths={n: sum(len(w) == n for w in words) for n in range(3, 9)},
        contentSha256=hashlib.sha256(data).hexdigest(),
        policy='3-8 lowercase letters; no capitalised (proper-name) entries; no NOSUGGEST (offensive) entries; '
               'no compound-only fragments; at least one vowel; abbreviation and profanity deny lists'),
        indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(words=len(words), sha256=hashlib.sha256(data).hexdigest())))


if __name__ == '__main__':
    main()
