"""Deterministic offline review evidence; no decisions, activation or corpus writes."""
from collections import defaultdict
import json
import re
import unicodedata


def runtime_normalized(text):
    """Mirror KingBank.normalize (Reflex), rather than the NFKC review normalizer."""
    return re.sub(r'\s+', ' ', re.sub(r'[.,!?]', '', text.strip().lower()))


def answer_set(row):
    c = row['content']
    if row['mode'] == 'EXPLAIN':
        return frozenset(runtime_normalized(unicodedata.normalize('NFKC', a).replace('’', "'"))
                         for a in [c['target']] + c['acceptedAliases'])
    return frozenset(runtime_normalized(a) for a in [c['canonical']] + c.get('accepted', []))


def presentation_collisions(rows):
    """Same complete question facts, different server accepted-answer sets.

    Difficulty labels, IDs, countdown and randomized tile order do not constrain an
    answer. Meanings and relationSet are not in KingBank.presentation before resolve.
    Use exact displayed strings: punctuation/case variants alone never quarantine.
    """
    groups = defaultdict(list)
    for r in rows:
        if r.get('mode') not in ('REFLEX', 'EXPLAIN') or not isinstance(r.get('content'), dict):
            continue
        c = r['content']
        if r['mode'] == 'EXPLAIN':
            if (not isinstance(c.get('target'), str) or not isinstance(c.get('acceptedAliases'), list)
                or any(not isinstance(a, str) for a in c['acceptedAliases'])
                or not isinstance(c.get('progressiveClues'), list)
                or len(c['progressiveClues']) != 3
                or any(not isinstance(a, str) for a in c['progressiveClues'])): continue
            # Solo/Echo authored clue sequence is identical at every reveal stage.
            fields = {'progressiveClues': c.get('progressiveClues')}
        else:
            if (not isinstance(c.get('canonical'), str) or not isinstance(c.get('accepted', []), list)
                or any(not isinstance(a, str) for a in c.get('accepted', []))): continue
            fields = {k: c.get(k) for k in ('prompt', 'context', 'tokens', 'options',
                                          'occurrenceStart', 'occurrenceEnd')}
        groups[(r['mode'], r.get('family'), json.dumps(fields, sort_keys=True, ensure_ascii=False))].append(r)
    result = []
    for (mode, family, fields), pool in sorted(groups.items()):
        if len({answer_set(r) for r in pool}) <= 1:
            continue
        result.append(dict(code='IDENTICAL_PRESENTATION_DIFFERENT_ACCEPTED_ANSWERS',
                           severity='BLOCKING', mode=mode, family=family, presentation=json.loads(fields),
                           items=[dict(id=r['id'], accepted=sorted(answer_set(r)),
                                       sourceRefs=r.get('sourceRefs', []))
                                  for r in sorted(pool, key=lambda r: r['id'])]))
    return result
