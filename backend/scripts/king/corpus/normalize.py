"""Deterministic canonical lexical database, separate from any runtime release.

Unknown upstream structure aborts the build. Raw files are never extracted to Git.
"""
import argparse
from contextlib import closing
import csv
import gzip
import io
import json
import re
import sqlite3
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path
from sources import CACHE, ROOT, EVIDENCE, registry, verify, write_json, sha256

WORK = ROOT / '.cache/king-corpus/normalized.sqlite'
POS = {'n':'noun','v':'verb','a':'adjective','s':'adjective','r':'adverb'}


def normalized(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC',text).casefold().replace('’',"'")).strip()


def create(db):
    db.executescript('''
    PRAGMA foreign_keys=ON;
    CREATE TABLE manifest(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE sources(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE concepts(id TEXT PRIMARY KEY,pos TEXT NOT NULL,definition TEXT NOT NULL,
                          examples TEXT NOT NULL,relations TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id));
    CREATE TABLE lexemes(id TEXT PRIMARY KEY,lemma TEXT NOT NULL,normalized_lemma TEXT NOT NULL,pos TEXT NOT NULL,forms TEXT NOT NULL);
    CREATE TABLE senses(id TEXT PRIMARY KEY,lexeme_id TEXT NOT NULL REFERENCES lexemes(id),concept_id TEXT NOT NULL REFERENCES concepts(id),relations TEXT NOT NULL);
    CREATE TABLE profiles(lemma TEXT NOT NULL,pos TEXT NOT NULL,level TEXT NOT NULL,body TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id));
    CREATE TABLE grammar(id INTEGER PRIMARY KEY,body TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id));
    CREATE TABLE spelling(word TEXT NOT NULL,dialect TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),PRIMARY KEY(word,dialect));
    CREATE TABLE documents(id TEXT PRIMARY KEY,body_sha256 TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id));
    CREATE TABLE sentences(id TEXT PRIMARY KEY,text TEXT NOT NULL,normalized_text TEXT NOT NULL,document_id TEXT NOT NULL REFERENCES documents(id),start INTEGER NOT NULL,end INTEGER NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id));
    CREATE TABLE frequency(word TEXT PRIMARY KEY,count INTEGER NOT NULL,documents INTEGER NOT NULL);
    CREATE INDEX lexeme_lemma ON lexemes(normalized_lemma,pos);
    CREATE INDEX sense_concept ON senses(concept_id);
    CREATE INDEX profile_lemma ON profiles(lemma,pos);
    CREATE INDEX sentence_normalized ON sentences(normalized_text);
    ''')


def wordnet(db,path):
    # Two streaming passes allow FK checking without keeping the whole XML in RAM.
    for stage in ('Synset','LexicalEntry'):
        with gzip.open(path,'rb') as stream:
            lexicon_seen=False
            for event,element in ET.iterparse(stream,events=('start','end')):
                if event=='start' and element.tag=='Lexicon':
                    if element.get('version')!='2025' or element.get('language')!='en':
                        raise ValueError('WORDNET_VERSION_SCHEMA_MISMATCH')
                    lexicon_seen=True
                if event!='end' or element.tag not in {'Synset','LexicalEntry'}:
                    continue
                if element.tag==stage:
                    if stage=='Synset':
                        definition=element.findtext('Definition')
                        if not definition or element.get('partOfSpeech') not in POS:
                            raise ValueError('WORDNET_MALFORMED_SYNSET:'+str(element.get('id')))
                        db.execute('INSERT INTO concepts VALUES(?,?,?,?,?,?)',
                            (element.get('id'),POS[element.get('partOfSpeech')],definition,
                             json.dumps([x.text or '' for x in element.findall('Example')]),
                             json.dumps([dict(x.attrib) for x in element.findall('SynsetRelation')]),'oewn'))
                    else:
                        lemma=element.find('Lemma')
                        if lemma is None or lemma.get('partOfSpeech') not in POS:
                            raise ValueError('WORDNET_MALFORMED_LEXEME')
                        word=lemma.get('writtenForm')
                        if not word: raise ValueError('WORDNET_EMPTY_LEMMA')
                        db.execute('INSERT INTO lexemes VALUES(?,?,?,?,?)',(element.get('id'),word,normalized(word),POS[lemma.get('partOfSpeech')],
                            json.dumps([dict(x.attrib) for x in element.findall('Form')])))
                        for sense in element.findall('Sense'):
                            db.execute('INSERT INTO senses VALUES(?,?,?,?)',(sense.get('id'),element.get('id'),sense.get('synset'),
                                json.dumps([dict(x.attrib) for x in sense.findall('SenseRelation')])))
                element.clear()
            if not lexicon_seen: raise ValueError('WORDNET_LEXICON_MISSING')


def profiles(db,path):
    with path.open(encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream)
        if not {'headword','pos','CEFR'} <= set(reader.fieldnames):
            raise ValueError('CEFRJ_VOCAB_SCHEMA_CHANGED')
        for row in reader:
            if row['CEFR'] not in {'A1','A2','B1','B2'}: raise ValueError('CEFRJ_INVALID_LEVEL')
            db.execute('INSERT INTO profiles VALUES(?,?,?,?,?)',(normalized(row['headword']),row['pos'],row['CEFR'],json.dumps(row),'cefrj-vocabulary'))


def grammar(db,path):
    with path.open(encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream)
        if not reader.fieldnames or len(reader.fieldnames)<5: raise ValueError('CEFRJ_GRAMMAR_SCHEMA_CHANGED')
        for n,row in enumerate(reader,1):
            if None in row: raise ValueError('CEFRJ_GRAMMAR_MALFORMED_ROW')
            db.execute('INSERT INTO grammar VALUES(?,?,?)',(n,json.dumps(row,ensure_ascii=False),'cefrj-grammar'))


def speller(db,path,source,dialect):
    with zipfile.ZipFile(path) as archive:
        names=[x for x in archive.namelist() if x.endswith('.dic')]
        if len(names)!=1: raise ValueError('SCOWL_ARCHIVE_SCHEMA_CHANGED')
        lines=archive.read(names[0]).decode('utf-8-sig').splitlines()
        if not lines[0].isdigit() or int(lines[0])!=len(lines)-1: raise ValueError('SCOWL_COUNT_MISMATCH')
        # Preserve lexical roots only; never infer inflection forms from unknown affixes.
        for line in lines[1:]:
            word=line.split('/')[0]
            if re.fullmatch('[a-z]{3,16}',word):
                db.execute('INSERT OR IGNORE INTO spelling VALUES(?,?,?)',(word,dialect,source))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,default=WORK)
    args=parser.parse_args();args.out.parent.mkdir(parents=True,exist_ok=True)
    lock=registry();temporary=args.out.with_suffix('.building.sqlite')
    if temporary.exists():temporary.unlink()
    with closing(sqlite3.connect(temporary)) as db:
        create(db)
        for source in lock['sources']:
            db.execute('INSERT INTO sources VALUES(?,?)',(source['id'],json.dumps(source,sort_keys=True)))
        db.execute('INSERT INTO manifest VALUES(?,?)',('sourceLockSha256',sha256(Path(__file__).parent/'sources.lock.json')))
        for source in lock['sources']:
            if source['id'] not in {'oewn','cefrj-vocabulary','cefrj-grammar','scowl-us','scowl-gb'}:continue
            path=CACHE/source['cacheFile'];verify(source,path)
            if source['id']=='oewn':wordnet(db,path)
            elif source['id']=='cefrj-vocabulary':profiles(db,path)
            elif source['id']=='cefrj-grammar':grammar(db,path)
            else:speller(db,path,source['id'],'US' if source['id']=='scowl-us' else 'GB')
            print('NORMALIZED '+source['id'],flush=True)
        db.commit()
        if db.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('BROKEN_CANONICAL_LINKS')
        summary={table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in
                 ('concepts','lexemes','senses','profiles','grammar','spelling')}
        db.execute('VACUUM')
    temporary.replace(args.out)
    summary.update(bytes=args.out.stat().st_size,sha256=sha256(args.out),runtimeArtifact=False)
    write_json(EVIDENCE/'normalization.json',summary);print(json.dumps(summary))


if __name__=='__main__':main()
