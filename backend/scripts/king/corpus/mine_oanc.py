"""Mine annotated written OANC spans; keep offsets and POS evidence, never guess POS.

All data remains in the ignored canonical working DB. Spoken transcripts, letters,
telephone and email genres are excluded from this learner candidate pass.
"""
import bisect
from collections import Counter
from contextlib import closing
import hashlib
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
import zipfile
from normalize import WORK, normalized
from sources import CACHE, EVIDENCE, registry, verify, write_json

NS='{http://www.xces.org/ns/GrAF/1.0/}'
XML_ID='{http://www.w3.org/XML/1998/namespace}id'


def annotations(data, text, pos=False):
    tree=ET.fromstring(data)
    if tree.tag!=NS+'graph':raise ValueError('OANC_GRAPH_SCHEMA_CHANGED')
    regions={r.get(XML_ID):tuple(map(int,r.attrib['anchors'].split())) for r in tree.findall(NS+'region')}
    nodes={n.get(XML_ID):n.find(NS+'link').attrib['targets'] for n in tree.findall(NS+'node')}
    result=[]
    for a in tree.findall(NS+'a'):
        if a.get('label') not in ({'tok'} if pos else {'s'}):continue
        start,end=regions[nodes[a.attrib['ref']]]
        if not 0<=start<end<=len(text):raise ValueError(f'OANC_INVALID_OFFSETS:{start}:{end}:length={len(text)}')
        fields={f.get('name'):f.get('value') for f in a.findall('.//'+NS+'f')}
        if pos and not fields.get('msd'):raise ValueError('OANC_MISSING_POS')
        result.append((start,end,fields))
    return sorted(result)


def main():
    source=next(s for s in registry()['sources'] if s['id']=='oanc')
    archive_path=CACHE/source['cacheFile'];verify(source,archive_path)
    stats=Counter();frequency=Counter();doc_frequency=Counter();pairs=Counter();pair_docs=Counter();quarantine=[]
    with closing(sqlite3.connect(WORK)) as db, zipfile.ZipFile(archive_path) as archive:
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript('''CREATE TABLE IF NOT EXISTS sentence_annotations(id TEXT PRIMARY KEY REFERENCES sentences(id),body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS collocations(first TEXT,second TEXT,pattern TEXT,count INTEGER,documents INTEGER,PRIMARY KEY(first,second,pattern));''')
        learner={r[0] for r in db.execute('SELECT lemma FROM profiles')}
        db.execute('DELETE FROM sentence_annotations');db.execute('DELETE FROM sentences');db.execute('DELETE FROM documents')
        db.execute('DELETE FROM frequency');db.execute('DELETE FROM collocations')
        names=set(archive.namelist())
        for name in sorted(n for n in names if n.endswith('.txt')):
            stats['totalDocuments']+=1
            if '/written_' not in name or re.search(r'/(letters|email|telephone|verbatim)/',name):
                stats['excludedGenreDocuments']+=1;continue
            base=name[:-4];sentfile=base+'-s.xml';posfile=base+'-hepple.xml'
            if sentfile not in names or posfile not in names:
                stats['missingAnnotationDocuments']+=1;continue
            raw=archive.read(name);text=raw.decode('utf-8');doc=base.removeprefix('OANC-GrAF/data/')
            try:
                spans=annotations(archive.read(sentfile),text)
                tagged=annotations(archive.read(posfile),text,True)
            except (ValueError,KeyError,ET.ParseError) as error:
                stats['quarantinedAnnotationDocuments']+=1
                quarantine.append(dict(document=doc,reason=str(error)))
                continue
            starts=[x[0] for x in tagged]
            db.execute('INSERT INTO documents VALUES(?,?,?)',(doc,hashlib.sha256(raw).hexdigest(),'oanc'))
            stats['parsedDocuments']+=1;localfreq=Counter();localpairs=Counter()
            for start,end,fields in tagged:
                word=normalized(text[start:end]);pos=fields['msd']
                if re.fullmatch('[a-z]+',word) and not pos.startswith('NNP'):localfreq[word]+=1
            frequency.update(localfreq);doc_frequency.update(localfreq.keys())
            for start,end,_ in spans:
                stats['annotatedSentenceSpans']+=1
                sentence=re.sub(r'\s+',' ',text[start:end]).strip()
                if not re.fullmatch(r"[A-Za-z][A-Za-z ,;'!?().:-]*[.!?]",sentence) or not 4<=len(sentence.split())<=14:
                    stats['rejectedSurface']+=1;continue
                i=bisect.bisect_left(starts,start);j=bisect.bisect_left(starts,end)
                tokens=[dict(text=text[a:b],pos=f['msd'],lemma=f.get('base'),start=a,end=b) for a,b,f in tagged[i:j] if b<=end]
                if not tokens or any(t['pos'].startswith('NNP') for t in tokens):
                    stats['rejectedProperName']+=1;continue
                if any(w[0].isupper() and w!='I' for w in sentence.split()[1:]):
                    stats['rejectedCapitalizedName']+=1;continue
                words=[t for t in tokens if re.fullmatch('[A-Za-z]+',t['text'])]
                if not words or sum(normalized(t.get('lemma') or t['text']) in learner for t in words)/len(words)<.8:
                    stats['rejectedLearnerCoverage']+=1;continue
                # Sensitive/offensive topics are review-only; initial pass excludes exact markers.
                if re.search(r'\b(?:fuck\w*|shit\w*|nigger\w*|suicid\w*|rape\w*|sex\w*|kill\w*|murder\w*)\b',sentence,re.I):
                    stats['rejectedSensitiveTopic']+=1;continue
                sid='oanc:'+doc+':'+str(start)+'-'+str(end)
                db.execute('INSERT INTO sentences VALUES(?,?,?,?,?,?,?)',(sid,sentence,normalized(sentence),doc,start,end,'oanc'))
                db.execute('INSERT INTO sentence_annotations VALUES(?,?)',(sid,json.dumps(tokens)))
                stats['retainedCandidateSentences']+=1
                for a,b in zip(words,words[1:]):
                    # Adjacency in word stream alone does not establish phrase meaning.
                    pattern=None
                    if a['pos'].startswith('VB') and b['pos'].startswith('NN'):pattern='VERB_NOUN'
                    elif a['pos'].startswith('JJ') and b['pos'].startswith('NN'):pattern='ADJECTIVE_NOUN'
                    elif a['pos'].startswith('RB') and b['pos'].startswith('JJ'):pattern='ADVERB_ADJECTIVE'
                    if pattern and a['end']<=b['start'] and text[a['end']:b['start']].isspace():
                        localpairs[(normalized(a['text']),normalized(b['text']),pattern)]+=1
            pairs.update(localpairs);pair_docs.update(localpairs.keys())
            if stats['parsedDocuments']%500==0:print('DOCUMENTS '+str(stats['parsedDocuments']),flush=True)
        db.executemany('INSERT INTO frequency VALUES(?,?,?)',((w,c,doc_frequency[w]) for w,c in sorted(frequency.items())))
        db.executemany('INSERT INTO collocations VALUES(?,?,?,?,?)',((*p,c,pair_docs[p]) for p,c in sorted(pairs.items()) if c>=5 and pair_docs[p]>=3))
        stats['collocationEvidencePairs']=db.execute('SELECT count(*) FROM collocations').fetchone()[0]
        db.commit()
    write_json(EVIDENCE/'oanc-quarantine.json',quarantine)
    write_json(EVIDENCE/'oanc-mining.json',dict(stats));print(json.dumps(dict(stats)))


if __name__=='__main__':main()
