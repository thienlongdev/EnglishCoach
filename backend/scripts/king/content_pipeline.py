"""Offline King review pipeline. No network, runtime imports or application DB writes.

The runtime engineering JSON remains immutable input. Review envelopes fingerprint
ALL content and provenance, unlike legacy checksums. Output is a release artifact;
it does not enable the production game. Owner decisions must be supplied separately.
"""
import argparse
import copy
import csv
import hashlib
import html
import json
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'backend/src/main/resources/data/king'
VERSION = 'king-review-4.0.0'
STATES = {'DRAFT', 'AUTO_VALIDATED', 'HUMAN_REVIEW_PENDING', 'HUMAN_APPROVED', 'REJECTED', 'ACTIVE'}
FAMILIES = {'LETTER_SCRAMBLE', 'MISSING_LETTER', 'SPELLING_CORRECTION', 'SPELLING_CHOICE',
            'WORD_FAMILY', 'PART_OF_SPEECH', 'SYNONYM', 'ANTONYM', 'COLLOCATION',
            'PHRASAL_VERB', 'IDIOM_FRAGMENT', 'GRAMMAR_TRAP', 'FIXED_EXPRESSION'}
HINT = re.compile(r'\b(starts?|begins?|ends?)\s+with\b|\b(first|last|second|third|fourth|fifth|sixth|seventh|eighth|\d+(st|nd|rd|th)?)\s+(letter|character)\b|\b(letter|character)\s+(number\s+)?\d+\s+(is|equals?)\b|\b(has|contains?|with|of)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(letters?|characters?)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -]+letter\s+word\b|\b(spell(ed|ing)?|rhymes?\s+with)\b',re.I)


def normalized(value):
    return re.sub(r'\s+', ' ', re.sub(r'[.,!?]', '', unicodedata.normalize('NFKC', value).lower().replace('’', "'")).strip())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def fingerprint(record):
    # Validation findings and review state are derived; content and lineage are bound.
    return digest({key: record[key] for key in ('id', 'mode', 'content', 'provenance', 'contentVersion')})


def wrap(item, mode, source, derivation='IDENTITY_IMPORT', parent=None):
    content = {k: v for k, v in item.items() if k not in {'fingerprint', 'status', 'reviewStatus', 'humanReview'}}
    record = dict(id=item['id'], mode=mode, content=content,
                  provenance=dict(sourceKind=item['sourceKind'], sourceRef=source,
                                  sourceVersion=item.get('contentVersion', item.get('version')),
                                  sourceFingerprint=parent or item['fingerprint'], derivationRule=derivation,
                                  sourcePolicy='LOCAL_ENGINEERING_REVIEW_ONLY; redistribution/license requires owner verification'),
                  contentVersion=VERSION, fingerprint='', reviewStatus='DRAFT', humanReview=None)
    record['fingerprint'] = fingerprint(record)
    return record


def import_sources(derive=True):
    records = []
    for filename, mode in [('engineering.json', None), ('explain-engineering.json', 'EXPLAIN'), ('conquest-engineering.json', 'CONQUEST')]:
        items = json.loads((DATA / filename).read_text(encoding='utf-8'))
        for item in items:
            records.append(wrap(item, mode or item['mode'], f'backend/src/main/resources/data/king/{filename}#{item["id"]}'))
    if derive:
        # Reuse complete authored English sentences only. No synonym expansion or
        # invented translation. Shared generic clues deduplicate before counting.
        for parent in list(records):
            if parent['mode'] != 'EXPLAIN':
                continue
            c = parent['content']
            for n, sentence in enumerate(c['progressiveClues']):
                tokens = re.sub(r'[.,!?]', '', sentence).split()
                if not 4 <= len(tokens) <= 18 or not re.fullmatch(r"[A-Za-z' ,.!?-]+", sentence):
                    continue
                item = dict(id=f'{c["id"]}-sentence-{n+1}', mode='REORDER', family='DESCRIPTIVE_SENTENCE',
                            prompt=f'Arrange a description of: {c["target"]}', tokens=tokens, options=[],
                            canonical=sentence, accepted=[], meaning=f'Description of {c["target"]}: {c["meaning"]}',
                            difficulty=c['difficulty'], cefr=c['cefr'], cefrBasis='INHERITED_ENGINEERING_ESTIMATE',
                            sourceKind='DETERMINISTIC_LOCAL_DERIVATION', version=VERSION,
                            expression=None, context=None, relationSet=[], missingIndex=None,
                            sourceRef=parent['provenance']['sourceRef'], fingerprint=parent['fingerprint'])
                records.append(wrap(item, 'REORDER', parent['provenance']['sourceRef'], 'EXPLAIN_CLUE_TO_REORDER_V1', parent['fingerprint']))
        # A word's spelling is ONE semantic task, regardless of masked position,
        # typo or shuffle. Add at most two per spelling family to avoid dominance.
        parents = [r for r in records if r['mode'] == 'EXPLAIN' and re.fullmatch('[a-z]{4,12}', r['content']['target'])]
        existing = {spelling_key(r['content']) for r in records if r['mode'] == 'REFLEX' and r['content']['family'].startswith(('SPELLING', 'LETTER', 'MISSING'))}
        families = ['LETTER_SCRAMBLE', 'MISSING_LETTER', 'SPELLING_CORRECTION', 'SPELLING_CHOICE'] * 2
        for family, parent in zip(families, [r for r in parents if r['content']['target'] not in existing]):
            c, word = parent['content'], parent['content']['target']
            index = len(word)//2
            typo = word[:index] + word[index+1] + word[index] + word[index+2:]
            if typo == word:
                continue
            item = dict(id=f'{c["id"]}-spelling', mode='REFLEX', family=family, prompt=c['progressiveClues'][-1],
                        tokens=list(word) if family == 'LETTER_SCRAMBLE' else [], options=[], accepted=[],
                        canonical=word, expression=word, context=c['progressiveClues'][-1], relationSet=[], missingIndex=None,
                        meaning=c['meaning'], difficulty=c['difficulty'], cefr=c['cefr'], cefrBasis='INHERITED_ENGINEERING_ESTIMATE',
                        sourceKind='DETERMINISTIC_LOCAL_DERIVATION', sourceRef=parent['provenance']['sourceRef'], version=VERSION, fingerprint=parent['fingerprint'])
            if family == 'MISSING_LETTER':
                item.update(prompt=word[:index]+'_'+word[index+1:], canonical=word[index], missingIndex=index)
            elif family == 'SPELLING_CORRECTION':
                item['prompt'] = typo
            elif family == 'SPELLING_CHOICE':
                item['options'] = [typo, word]
            records.append(wrap(item, 'REFLEX', parent['provenance']['sourceRef'], f'EXPLAIN_TO_{family}_V1', parent['fingerprint']))
    return records


def spelling_key(c):
    if c['family'] == 'MISSING_LETTER':
        return c['prompt'].replace('_', c['canonical'])
    return normalized(c['canonical'])


def semantic_key(r):
    c, mode = r['content'], r['mode']
    if mode == 'REORDER':
        return mode, normalized(c['canonical'])
    if mode == 'EXPLAIN':
        return mode, normalized(c['target'])
    if mode == 'CONQUEST':
        return mode, ''.join(c['letters'])
    if c['family'] in {'LETTER_SCRAMBLE', 'MISSING_LETTER', 'SPELLING_CORRECTION', 'SPELLING_CHOICE'}:
        return mode, 'SPELLING', spelling_key(c)
    return mode, c['family'], normalized(c.get('expression') or c['prompt']), normalized(c.get('context') or '')


def quality(record):
    try:
        return _quality(record)
    except (KeyError, TypeError, ValueError, AttributeError, IndexError):
        return ['MALFORMED_CONTENT_SCHEMA'], ['HUMAN_LINGUISTIC_REVIEW_REQUIRED']


def _quality(record):
    """Structural errors block approval; heuristic warnings ALWAYS require review."""
    c, mode = record['content'], record['mode']
    errors, warnings = [], ['HUMAN_LINGUISTIC_REVIEW_REQUIRED', 'CEFR_ESTIMATE_REVIEW']
    if fingerprint(record) != record['fingerprint']:
        errors.append('STALE_FINGERPRINT')
    if not all(record['provenance'].get(k) for k in ('sourceKind', 'sourceRef', 'sourceVersion', 'derivationRule', 'sourceFingerprint', 'sourcePolicy')):
        errors.append('MISSING_PROVENANCE')
    if mode != 'CONQUEST' and (not c.get('meaning') or not 1 <= c.get('difficulty', 0) <= 5 or c.get('cefr') not in {'A1','A2','B1','B2','C1','C2'}):
        errors.append('MISSING_MEANING_OR_LEVEL')
    if mode == 'REORDER':
        sentence = c['canonical']
        tokens = Counter(normalized(' '.join(c['tokens'])).split())
        if not 2 <= len(c['tokens']) <= 24 or tokens != Counter(normalized(sentence).split()):
            errors.append('TOKEN_MISMATCH')
        if any(Counter(normalized(a).split()) != tokens for a in c['accepted']):
            errors.append('ALTERNATIVE_TOKEN_MISMATCH')
        checks = [('ARTICLE_OR_REFERENCE_AMBIGUITY', r'\b(a|an|the|it|this|that)\b'),
                  ('ADVERB_POSITION_REVIEW', r'\b(\w+ly|yesterday|tomorrow|often|sometimes|always|never)\b'),
                  ('CONTRACTION_POLICY', r"\w+'\w+"), ('OPTIONAL_PUNCTUATION', r'[.,!?]'),
                  ('REGIONAL_SPELLING', r'\b(colou?r\w*|travell?\w*|organi[sz]\w*)\b')]
        warnings += [name for name, pattern in checks if re.search(pattern, sentence, re.I)]
        if any(v > 1 for v in tokens.values()): warnings.append('REPEATED_TOKEN_INDEX_REVIEW')
        if c['family'] in {'PHRASAL_VERB', 'COLLOCATION', 'IDIOM', 'INVERSION', 'FIXED_EXPRESSION'}:
            warnings.append(c['family']+'_COMPLETENESS_REVIEW')
        if c['family'] == 'PHRASAL_VERB' and not c['accepted']: warnings.append('OBJECT_POSITION_ALTERNATIVE_MISSING')
    elif mode == 'REFLEX':
        family, answer = c['family'], normalized(c['canonical'])
        if family not in FAMILIES: errors.append('INVALID_FAMILY')
        opts = [normalized(x) for x in c['options']]
        if opts and (len(set(opts)) != len(opts) or answer not in opts): errors.append('CHOICES_NOT_UNIQUE')
        if family == 'LETTER_SCRAMBLE' and Counter(c['tokens']) != Counter(answer): errors.append('TOKEN_MISMATCH')
        if family == 'MISSING_LETTER':
            index = c.get('missingIndex')
            if not isinstance(index, int) or not 0 <= index < len(c['prompt']) or c['prompt'][index] != '_' or len(answer) != 1:
                errors.append('INVALID_MISSING_INDEX')
        if family in {'SPELLING_CHOICE', 'SPELLING_CORRECTION'}:
            distractors = [c['prompt']] if family == 'SPELLING_CORRECTION' else [x for x in opts if x != answer]
            if not distractors or any(not re.fullmatch('[a-z]+', d) or edit_distance(answer, d) > 2 or d == answer for d in distractors):
                errors.append('IMPLAUSIBLE_SPELLING_DISTRACTOR')
            warnings.append('DISTRACTOR_LEXICAL_VALIDITY_REVIEW')
        if family == 'WORD_FAMILY':
            if not re.search(r'\b(noun|verb|adjective|adverb)\b', c['prompt'], re.I): errors.append('POS_REQUEST_MISSING')
            warnings.append('WORD_FAMILY_SENSE_REVIEW')
        if family == 'PART_OF_SPEECH' and not c.get('context'): errors.append('POS_CONTEXT_MISSING')
        if family in {'SYNONYM', 'ANTONYM'}:
            if answer not in c['relationSet']: errors.append('RELATION_ANSWER_MISSING')
            warnings.append('REGISTER_AND_SENSE_REVIEW')
        if family in {'COLLOCATION','PHRASAL_VERB','IDIOM_FRAGMENT','FIXED_EXPRESSION'} and not c.get('expression'):
            errors.append('CANONICAL_EXPRESSION_MISSING')
        if family == 'GRAMMAR_TRAP': warnings.append('SINGLE_CORRECT_CHOICE_REVIEW')
    elif mode == 'EXPLAIN':
        forms = [c['target']] + c['acceptedAliases'] + c['forbiddenForms']
        clues = c['progressiveClues']
        if len(clues) != 3 or len(set(clues)) != 3 or any(not x.strip() or len(x) > 400 for x in clues): errors.append('INVALID_CLUE_STAGES')
        for clue in clues:
            if any(re.search(r'(?<![a-z])' + r'[\W_]*'.join(map(re.escape, re.sub('[^a-z]', '', normalized(f)))) + r'(?![a-z])', normalized(clue)) for f in forms if normalized(f)):
                errors.append('TARGET_OR_ALIAS_LEAKAGE')
            if HINT.search(clue): errors.append('SPELLING_HINT')
        warnings += ['CLUE_PROGRESSION_AND_NATURALNESS_REVIEW', 'MEANING_TARGET_ALIGNMENT_REVIEW', 'KNOWN_FORMS_COMPLETENESS_REVIEW']
        if c['acceptedAliases']: warnings.append('ALIAS_EQUIVALENCE_REVIEW')
    elif mode == 'CONQUEST':
        q = c['qualityMetrics']
        if len(c['letters']) != 25 or any(not re.fullmatch('[A-Z]', x) for x in c['letters']): errors.append('INVALID_BOARD')
        if q['playableWords'] < 50 or q['shortWords'] < 20 or q['longWords'] < 8 or q['throneWords'] < 8 or len(q['cellCoverage']) != 25 or min(q['cellCoverage']) < 2: errors.append('BOARD_THRESHOLD')
        candidates=c['echoCandidates']
        if not 24<=len(candidates)<=32 or len({x['word'] for x in candidates})!=len(candidates): errors.append('INVALID_ECHO_POOL')
        for x in candidates:
            path=x['path']
            if not 3<=len(path)<=8 or len(set(path))!=len(path) or any(not isinstance(i,int) or not 0<=i<25 for i in path):
                errors.append('INVALID_ECHO_PATH');continue
            if any(max(abs(a//5-b//5),abs(a%5-b%5))!=1 for a,b in zip(path,path[1:])) or ''.join(c['letters'][i].lower() for i in path)!=x['word']: errors.append('INVALID_ECHO_PATH')
        warnings += ['PROPER_NOUN_HEURISTIC_REVIEW', 'BOARD_SOLVER_REVERIFY_REQUIRED']
    else: errors.append('INVALID_MODE')
    return sorted(set(errors)), sorted(set(warnings))


def edit_distance(a, b):
    row = list(range(len(b)+1))
    for i, x in enumerate(a, 1):
        new = [i]
        for j, y in enumerate(b, 1): new.append(min(new[-1]+1, row[j]+1, row[j-1]+(x != y)))
        row = new
    return row[-1]


def prepare(records):
    result, seen_ids, seen_semantics, audit = [], set(), set(), []
    for original in records:
        r = copy.deepcopy(original)
        errors, warnings = quality(r)
        if r['id'] in seen_ids: errors.append('DUPLICATE_ID')
        key = semantic_key(r)
        if key in seen_semantics: errors.append('SEMANTIC_DUPLICATE')
        seen_ids.add(r['id']); seen_semantics.add(key)
        r.update(errors=sorted(set(errors)), warnings=warnings, humanReview=None,
                 reviewStatus='DRAFT' if errors else 'HUMAN_REVIEW_PENDING')
        audit.append(dict(id=r['id'], fingerprint=r['fingerprint'], states=['DRAFT'] + ([] if errors else ['AUTO_VALIDATED','HUMAN_REVIEW_PENDING']), stages=['SOURCE','NORMALIZE','DERIVE','AUTO_VALIDATE','DEDUPLICATE','AMBIGUITY_CHECK'] + ([] if errors else ['HUMAN_REVIEW_PENDING']), errors=r['errors']))
        result.append(r)
    return result, audit


def revalidate_drafts(records):
    result, audit = copy.deepcopy(records), []
    ids = Counter(r['id'] for r in result)
    semantics = Counter(semantic_key(r) for r in result if not quality(r)[0])
    for r in result:
        if r['reviewStatus'] != 'DRAFT': continue
        errors, warnings = quality(r)
        if ids[r['id']] > 1: errors.append('DUPLICATE_ID')
        if not errors and semantics[semantic_key(r)] > 1: errors.append('SEMANTIC_DUPLICATE')
        r.update(errors=errors,warnings=warnings,humanReview=None)
        if not errors: r['reviewStatus']='HUMAN_REVIEW_PENDING'
        audit.append(dict(id=r['id'],fingerprint=r['fingerprint'],states=['DRAFT']+([] if errors else ['AUTO_VALIDATED','HUMAN_REVIEW_PENDING']),errors=errors))
    return result,audit


def import_decisions(records, decisions, reviewer):
    if not isinstance(reviewer, str) or not reviewer.strip(): raise ValueError('OWNER_REVIEWER_REQUIRED')
    result, errors, seen = copy.deepcopy(records), [], set()
    index = {r['id']: r for r in result}
    for d in decisions:
        item_id = d.get('id'); r = index.get(item_id)
        try:
            if item_id in seen: raise ValueError('DUPLICATE_DECISION')
            seen.add(item_id)
            if r is None: raise ValueError('UNKNOWN_ID')
            if d.get('fingerprint') != fingerprint(r) or r['fingerprint'] != fingerprint(r): raise ValueError('STALE_REVIEW_FINGERPRINT')
            if d.get('reviewer') != reviewer: raise ValueError('REVIEWER_MISMATCH')
            at = datetime.fromisoformat(d['reviewedAt'].replace('Z','+00:00'))
            if at.tzinfo is None or at > datetime.now(timezone.utc): raise ValueError('INVALID_TIMESTAMP')
            if d.get('decision') not in {'APPROVE', 'REJECT', 'CORRECT'}: raise ValueError('INVALID_DECISION')
            if d['decision'] == 'CORRECT':
                if not isinstance(d.get('correctedContent'), dict) or not d['correctedContent']: raise ValueError('CORRECTION_REQUIRED')
                r['content'] = d['correctedContent']; r['humanReview'] = None
                r['fingerprint'] = fingerprint(r); r['reviewStatus'] = 'DRAFT'
                r['errors'], r['warnings'] = quality(r)
                if 'MALFORMED_CONTENT_SCHEMA' in r['errors']: raise ValueError('MALFORMED_CORRECTION_SCHEMA')
            elif d['decision'] == 'REJECT':
                r['reviewStatus'] = 'REJECTED'; r['humanReview'] = copy.deepcopy(d)
            else:
                current_errors, current_warnings = quality(r)
                if r.get('errors') or current_errors: raise ValueError('AUTO_VALIDATION_FAILED')
                if r['reviewStatus'] != 'HUMAN_REVIEW_PENDING': raise ValueError('INVALID_REVIEW_TRANSITION')
                if set(current_warnings) - set(d.get('acknowledgedWarnings', [])): raise ValueError('WARNINGS_NOT_ACKNOWLEDGED')
                r['warnings'] = current_warnings
                r['reviewStatus'] = 'HUMAN_APPROVED'; r['humanReview'] = copy.deepcopy(d)
        except (ValueError, KeyError, TypeError) as e:
            errors.append(dict(id=item_id, reason=str(e)))
    # Fail atomically; no partially imported manifest on any bad row.
    if errors: raise ValueError(json.dumps(errors, ensure_ascii=False))
    return result


def active_build(records, reviewer):
    if not reviewer or not reviewer.strip(): raise ValueError('OWNER_REVIEWER_REQUIRED')
    result = []
    for r in records:
        review = r.get('humanReview')
        if r['reviewStatus'] != 'HUMAN_APPROVED': continue
        if not review: raise ValueError('MISSING_OWNER_DECISION')
        # Revalidate every decision and fingerprint; status alone grants nothing.
        pending = copy.deepcopy(r); pending['reviewStatus'] = 'HUMAN_REVIEW_PENDING'
        approved = import_decisions([pending], [review], reviewer)[0]
        approved['reviewStatus'] = 'ACTIVE'; result.append(approved)
    ids = [r['id'] for r in result]; keys = [semantic_key(r) for r in result]
    if len(set(ids)) != len(ids) or len(set(keys)) != len(keys): raise ValueError('DUPLICATE_ACTIVE_CONTENT')
    boards = [r for r in result if r['mode'] == 'CONQUEST']
    if boards:
        # Approval cannot turn asserted metrics into solver evidence. Reverify offline
        # against the canonical read-only corpus at the explicit active-build boundary.
        import generate_boards as generator
        trie = generator.trie(generator.corpus())
        for r in boards:
            c=r['content']; paths=generator.solve(c['letters'],trie)
            if generator.metrics(paths)!=c['qualityMetrics'] or not generator.quality(generator.metrics(paths),paths):
                raise ValueError('ACTIVE_BOARD_SOLVER_MISMATCH')
            for candidate in c['echoCandidates']:
                path=candidate['path'];word=candidate['word']
                if word not in paths or len(set(path))!=len(path) or not all(0<=i<25 for i in path) or any(b not in generator.NEIGHBOURS[a] for a,b in zip(path,path[1:])) or ''.join(c['letters'][i].lower() for i in path)!=word:
                    raise ValueError('ACTIVE_ECHO_CANDIDATE_INVALID')
    return result


def report(records):
    output = dict(pipelineVersion=VERSION, automaticValidationIsHumanApproval=False, productionRuntimeEnabled=False,
                  countingBasis='Normalized candidate keys, not human-certified linguistic semantic uniqueness; derived candidates are separate from runtime engineering banks.',modes={})
    for mode in ('REORDER','REFLEX','EXPLAIN','CONQUEST'):
        rows = [r for r in records if r['mode'] == mode]
        valid = [r for r in rows if not r['errors']]
        counts = dict(totalCandidates=len(rows), uniqueSemantic=len({semantic_key(r) for r in rows}), autoValid=len(valid), autoFailed=len(rows)-len(valid),
                      humanReviewPending=sum(r['reviewStatus']=='HUMAN_REVIEW_PENDING' for r in rows), humanApproved=sum(r['reviewStatus']=='HUMAN_APPROVED' for r in rows),
                      rejected=sum(r['reviewStatus']=='REJECTED' for r in rows), active=sum(r['reviewStatus']=='ACTIVE' for r in rows),
                      ambiguous=sum(len(r['warnings'])>2 for r in rows), duplicates=sum('SEMANTIC_DUPLICATE' in r['errors'] for r in rows),
                      missingProvenance=sum('MISSING_PROVENANCE' in r['errors'] for r in rows), staleApproval=sum(bool(r['humanReview']) and r['humanReview']['fingerprint']!=fingerprint(r) for r in rows),
                      generatedPresentationVariants=0, shuffles=0)
        if mode=='REFLEX': counts['families']=dict(sorted(Counter(r['content']['family'] for r in valid).items()))
        if mode in {'REORDER','EXPLAIN'}:
            counts['categories']=dict(sorted(Counter(r['content'].get('category', r['content'].get('family')) for r in valid).items()))
            counts['difficulty']=dict(sorted(Counter(str(r['content']['difficulty']) for r in valid).items()))
        output['modes'][mode]=counts
    return output


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def review_pack(out, records):
    out.mkdir(parents=True, exist_ok=True)
    summary=report(records); write_json(out/'content-report.json', summary); write_json(out/'candidates.json', records)
    # Blank decisions; CSV is for inspection. Owner exports a separate JSON manifest.
    with (out/'review.csv').open('w', encoding='utf-8-sig', newline='') as f:
        fields=['id','mode','fingerprint','reviewStatus','content','provenance','errors','warnings','decision','correction','reviewerNotes']
        writer=csv.DictWriter(f, fieldnames=fields); writer.writeheader()
        for r in records:
            row={k:json.dumps(r[k],ensure_ascii=False) if isinstance(r[k],(dict,list)) else r[k] for k in fields if k in r}
            # Prevent spreadsheet formula evaluation of future owner-imported text.
            writer.writerow({k:("'"+v if isinstance(v,str) and v.startswith(('=','+','-','@')) else v) for k,v in row.items()})
    sections=[]
    for mode in ('REORDER','REFLEX','EXPLAIN','CONQUEST'):
        cards=[]
        for r in records:
            if r['mode'] != mode: continue
            c=r['content']; title=c.get('canonical',c.get('target',''.join(c.get('letters',[]))))
            cards.append(f'<article id="{html.escape(r["id"])}"><h3>{html.escape(r["id"])} — {html.escape(title)}</h3><p>{html.escape(r["reviewStatus"])}</p><dl>' + ''.join(f'<dt>{html.escape(k)}</dt><dd>{html.escape(json.dumps(v,ensure_ascii=False))}</dd>' for k,v in c.items()) + f'</dl><p>Provenance: {html.escape(json.dumps(r["provenance"],ensure_ascii=False))}</p><p>Warnings: {html.escape(", ".join(r["warnings"]))}</p><p>Errors: {html.escape(", ".join(r["errors"]))}</p><code>{r["fingerprint"]}</code><p>Decision: ______ Correction: ______ Reviewer notes: ______</p></article>')
        sections.append(f'<section id="{mode}"><h2>{mode}</h2>'+''.join(cards)+'</section>')
    counts=''.join(f'<li>{m}: {v["totalCandidates"]} candidates; {v["autoValid"]} structurally valid; {v["humanReviewPending"]} pending; {v["humanApproved"]} approved; {v["active"]} active.</li>' for m,v in summary['modes'].items())
    flags=''.join(f'<li><a href="#{html.escape(r["id"])}">{html.escape(r["id"])}</a>: {html.escape(", ".join(r["errors"]+r["warnings"]))}</li>' for r in records if r['errors'] or len(r['warnings'])>2)
    (out/'review.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>King owner content review</title><style>body{font:16px system-ui;max-width:960px;margin:auto;padding:24px;color:#172339}article{border-top:1px solid #bbb;padding:20px 0;break-inside:avoid}dt{font-weight:600}dd,code{overflow-wrap:anywhere}dd{margin:0 0 8px}nav{display:flex;gap:20px;flex-wrap:wrap}</style><h1>King owner content review</h1><p>Engineering candidates. No decisions are prefilled. Automated checks do not certify English correctness or source licensing. This pack does not activate runtime content. Normalized sentence keys are not proof of unique meanings.</p><ul>'+counts+'</ul><details><summary>Flagged items and ambiguity review index</summary><ul>'+flags+'</ul></details><nav>'+''.join(f'<a href="#{m}">{m}</a>' for m in summary['modes'])+'</nav>'+''.join(sections)+'</html>',encoding='utf-8')
    (out/'README.md').write_text('# King owner review\n\nOpen review.html. Review every field and warning. Record decisions in a separate owner-created JSON array. Each record requires id, fingerprint, reviewer, reviewedAt (ISO timestamp with timezone), decision (APPROVE/REJECT/CORRECT), notes and acknowledgedWarnings (all listed warnings for approval). CORRECT requires correctedContent and returns to DRAFT with a new fingerprint; it never approves the correction.\n\nCreate owner.json containing {"reviewer":"your name"}. This identity must be owner supplied; none is supplied by this task. Run import with explicit --owner and --decisions. Then run a separate activate build. No production runtime switch, deployment or DB operation is performed by these tools. An imported manifest is an explicit owner attestation, not cryptographic authentication. Keep it in owner-controlled version history.\n\nCommands from repo root:\n\n`python backend/scripts/king/content_pipeline.py import --input docs/king-of-english/phase4/review/candidates.json --owner owner.json --decisions owner-decisions.json --out reviewed.json`\n\n`python backend/scripts/king/content_pipeline.py activate --input reviewed.json --owner owner.json --out active-build.json`\n\nCorrections must be repackaged and reviewed with their new fingerprint. Re-run pack on the reviewed input to inspect imported status. External textbook/dictionary examples are not imported: repository presence does not prove redistribution rights.\n',encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=['pack','import','activate'])
    parser.add_argument('--input',type=Path); parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--owner',type=Path); parser.add_argument('--decisions',type=Path)
    args=parser.parse_args()
    if args.action=='pack':
        if args.input:
            records,audit=revalidate_drafts(json.loads(args.input.read_text(encoding='utf-8')))
            args.out.mkdir(parents=True,exist_ok=True);write_json(args.out/'transition-audit.json',audit)
        else:
            records,audit=prepare(import_sources()); args.out.mkdir(parents=True,exist_ok=True); write_json(args.out/'transition-audit.json',audit)
        review_pack(args.out,records); print(json.dumps(report(records),ensure_ascii=False)); return
    if not args.input or not args.owner: parser.error('--input and owner-produced --owner required')
    records=json.loads(args.input.read_text(encoding='utf-8')); reviewer=json.loads(args.owner.read_text(encoding='utf-8'))['reviewer']
    if args.action=='import':
        if not args.decisions: parser.error('explicit owner-produced --decisions required')
        result=import_decisions(records,json.loads(args.decisions.read_text(encoding='utf-8')),reviewer)
    else: result=active_build(records,reviewer)
    write_json(args.out,result); print(json.dumps(dict(records=len(result),status=args.action)))


if __name__=='__main__': main()
