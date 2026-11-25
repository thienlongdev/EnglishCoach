"""Filesystem source inventory for owner-authorized Phase B recovery.

Recursion is confined to the immutable raw root. Archives are read, never extracted
into that root. Inventory evidence is not a content, identity, QA or release grant.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

from .corpus import RAW_ROOT, REPO_ROOT, HashCache, RawCorpusManifest
from .media import _probe_duration, MIME_BY_EXT
from .staging import _write_json


@contextmanager
def pdf_diagnostics():
    """Retain structural PDF warnings without flooding the terminal."""
    import pymupdf
    tools = pymupdf.TOOLS
    errors_on, warnings_on = tools.mupdf_display_errors(), tools.mupdf_display_warnings()
    tools.mupdf_warnings()
    tools.mupdf_display_errors(False)
    tools.mupdf_display_warnings(False)
    evidence = {}
    try:
        yield evidence
    finally:
        messages = tools.mupdf_warnings()
        evidence.update({'warningLines': len(messages.splitlines()),
                         'structuralWarningsPresent': bool(messages.strip())})
        tools.mupdf_display_errors(errors_on)
        tools.mupdf_display_warnings(warnings_on)


def family_of(path: str) -> str:
    pieces = path.lower().split('/')
    if len(pieces) >= 2 and pieces[0] in ('toeic', 'ielts'):
        return '/'.join(pieces[:2])
    return 'UNASSIGNED'


def family_source_groups(index: dict) -> dict:
    """Name-derived candidates from every real file/member, independent of manifest selectors.

    Ambiguous names remain unassigned. Candidate roles and identities are not QA.
    """
    groups, unassigned = {}, []
    for original in index['files'] + index['archiveMembers']:
        name = original.get('path') or original['archive'] + '::' + original['member']
        volumes = {int(n) for n in re.findall(r'vol(?:ume)?[\s_-]*(\d+)', name, re.I)}
        if original['family'] in ('toeic/ybm', 'toeic/economy'):
            if len(volumes) != 1:
                unassigned.append({'source': name, 'reason': 'VOLUME_NAME_UNPROVEN'})
                continue
            book = original['family'].split('/')[1] + '-vol-' + str(next(iter(volumes)))
        elif original['family'] == 'toeic/ets':
            years = {int(n) for n in re.findall(r'\bETS[\s_-]*(20\d{2})\b', name, re.I)}
            book = 'ets-' + str(next(iter(years))) if len(years) == 1 else 'family:toeic/ets'
        elif original['family'] == 'ielts/cambridge':
            editions = {int(n) for n in re.findall(r'cambridge(?:[\s_-]+ielts)?[\s_-]*(\d{1,2})(?!\d)', name, re.I)}
            book = 'cambridge-ielts-' + str(next(iter(editions))) if len(editions) == 1 else 'family:ielts/cambridge'
        else:
            book = 'family:' + original['family']
        tests = {int(n) for n in re.findall(r'(?:test|(?<![A-Za-z])AT)[\s_-]*0*(\d{1,2})(?!\d)', name, re.I)}
        stem = Path(name).stem
        if original['extension'] in ('.mp3', '.wav', '.m4a', '.ogg') and re.fullmatch(r'0*\d{1,2}', stem):
            tests.add(int(stem))
        parts = {int(n) for n in re.findall(r'part[\s_-]*0*(\d)(?!\d)', name, re.I)}
        scope = ('READING' if re.search(r'\bRC\b|\breading\b', name, re.I) else
                 'LISTENING' if re.search(r'\bLC(?:\d+)?\b|\blistening\b', name, re.I) else None)
        role = ('ANSWER_CANDIDATE' if re.search(r'answer|solution|정답|해설', name, re.I) else
                'PDF_CANDIDATE' if original['extension'] == '.pdf' else
                'AUDIO_CANDIDATE' if 'audio' in original else 'OTHER_SOURCE')
        groups.setdefault(book, []).append({**original, 'sourceIdentity': name,
                                            'testCandidate': next(iter(tests)) if len(tests) == 1 else None,
                                            'partCandidate': next(iter(parts)) if len(parts) == 1 else None,
                                            'scopeCandidate': scope, 'roleCandidate': role})
    return {'basis': index['basis'], 'families': groups, 'unassigned': unassigned,
            'identityProof': 'NAMING_CANDIDATES_REQUIRE_CONTENT_CORROBORATION', 'productionQualified': False}


def discovered_audio(test, candidates: list) -> list:
    """Augment manifest tracks from actual, unambiguous family/test naming.

    Names alone are PROBABLE; bind_audio and section-level corroboration retain
    the technical/mapping gates. Byte duplicates never create a second track.
    """
    audio = list(test.raw.get('audio', []))
    known = {(a['source'], a.get('archive_member')) for a in audio}
    known_hashes = {a.get('sha256') for a in audio if a.get('sha256')}
    for candidate in candidates:
        if candidate['roleCandidate'] != 'AUDIO_CANDIDATE' or candidate['testCandidate'] != test.test_number:
            continue
        source, member = (candidate.get('path') or candidate['archive'], candidate.get('member'))
        if (source, member) in known or candidate['sha256'] in known_hashes:
            continue
        part = candidate['partCandidate']
        if part is not None and part not in (1, 2, 3, 4):
            continue
        audio.append({'source': source, 'archive_member': member, 'part': part, 'section': None,
                      'scope': 'PART' if part else 'WHOLE_LISTENING', 'confidence': 'PROBABLE',
                      'rule': 'FILESYSTEM_FAMILY_TEST_PART' if part else 'FILESYSTEM_FAMILY_TEST',
                      'sha256': candidate['sha256'], 'duration_s': candidate.get('audio', {}).get('durationSeconds')})
        known.add((source, member))
        known_hashes.add(candidate['sha256'])
    return audio


def inspect_pdf(document) -> dict:
    """All native pages plus bounded back-matter markers; never stores source text."""
    markers = []
    text_pages, image_refs, annotations = 0, set(), []
    for n, page in enumerate(document, 1):
        if hasattr(page, 'get_images'):
            image_refs.update(image[0] for image in page.get_images(full=True))
        if hasattr(page, 'annots'):
            for annotation in page.annots() or []:
                content = annotation.info.get('content', '')
                annotations.append({'page': n, 'type': annotation.type[1],
                                    'answerMarker': bool(re.search(r'answer|solution|정답|해설', content, re.I))})
        text = page.get_text()
        text_pages += len(text.strip()) >= 100
        labels = [label for label, pattern in (
            ('ANSWER_KEY', r'answer\s*keys?|\banswers\b|정답'),
            ('SOLUTIONS', r'\bsolutions?\b|해설'),
            ('ANSWER_SHEET', r'answer\s*sheet'),
            ('SCORE_CONVERSION', r'score\s*(?:conversion|table)|점수\s*환산'),
            ('TEST_HEADER', r'\btest\s*0?\d{1,2}\b'))
            if re.search(pattern, text, re.I)]
        if labels:
            markers.append({'page': n, 'markers': labels})
    embedded = []
    if hasattr(document, 'embfile_names'):
        for name in document.embfile_names():
            data = document.embfile_get(name)
            embedded.append({'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return {'pages': len(document), 'nativeTextPages': text_pages,
            'embeddedFiles': embedded, 'embeddedImageObjectCount': len(image_refs), 'annotations': annotations,
            'backMatterPages': list(range(max(1, len(document) - 15), len(document) + 1)),
            'markers': markers, 'scannedMarkerSearchRequired': text_pages < len(document)}


def inspect_audio_metadata(source) -> dict:
    """Index tag structure and embedded image bytes; never publish tag values."""
    try:
        from mutagen import File
        audio = File(source)
        tags = audio.tags if audio else None
        images = []
        for key, value in (tags.items() if tags else []):
            payloads = ([value.data] if str(key).startswith('APIC') and hasattr(value, 'data') else
                        list(value) if key == 'covr' else [])
            for data in payloads:
                images.append({'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
                               'mime': getattr(value, 'mime', None)})
        return {'tagKeys': list(tags.keys()) if tags else [], 'embeddedImages': images}
    except Exception as exc:
        return {'metadataInspectionError': type(exc).__name__}


def scan_back_matter(index: dict, family: str, staging: Path, report_name=None) -> dict:
    """Search actual PDFs, including pages absent from the question selector.

    All pages are searched, including appended answer books before the final
    sections. Markers/density locate candidates; they do not grant keys.
    """
    from .ocr_engine import EasyOcrEngine, RegionOcrCache
    from .pdf_layer import PdfTextLayer
    cache = RegionOcrCache(staging / 'cache/ocr_regions', EasyOcrEngine())
    hashes = HashCache(staging / 'phase-b/source-hashes.json')
    profile_pages = profile_key_candidates(index)
    report_path = staging / 'phase-b' / (report_name or f'{family}-back-matter.json')
    results = []
    sources = sorted(index['files'], key=lambda r: -r.get('pdf', {}).get('pages', 0))
    for row in sources:
        if row['family'] != 'toeic/' + family or row['extension'] != '.pdf':
            continue
        if hashes.sha256(RAW_ROOT / row['path']) != row['sha256']:
            results.append({'path': row['path'], 'errorCode': 'SOURCE_HASH_MISMATCH', 'keyTables': []})
            continue
        layer = PdfTextLayer(RAW_ROOT / row['path'], 'imports/source-files/' + row['path'], row['sha256'])
        # Answer books may be appended before the final 40% (YBM2 LC starts
        # its solutions on page171 of465). Inspect every page; cached OCR
        # keeps repeat surveys incremental, including the question sections.
        start = 1
        found, failures, key_tables = [], [], []
        current = {'path': row['path'], 'sha256': row['sha256'],
                   'searchedPages': [start, 0], 'markers': found, 'keyTables': key_tables,
                   'ocrFailedPages': failures, 'keyCellProof': 'NOT_GRANTED_BY_MARKERS'}
        print(f"back-matter: {row['path']} pages {start}-{layer.page_count}", flush=True)
        for page in range(start, layer.page_count + 1):
            w, h = layer.page_size(page)
            result = cache.recognize(layer, page, (0, 0, w, h), dpi=150, pipeline='P1')
            if result is None:
                failures.append(page)
                continue
            text = ' '.join(word.text for word in result.words)
            labels = [label for label, pattern in (
                ('ANSWER_KEY', r'answer\s*keys?|\banswers\b|정답'),
                ('SOLUTIONS', r'\bsolutions?\b|해설'),
                ('ANSWER_SHEET', r'answer\s*sheet'),
                ('SCORE_CONVERSION', r'score\s*(?:conversion|table)|점수\s*환산'),
                ('TEST_HEADER', r'\btest\s*0?\d{1,2}\b')) if re.search(pattern, text, re.I)]
            if labels:
                found.append({'page': page, 'markers': labels})
            numbers = sum(bool(re.fullmatch(r'\d{1,3}[.)]?', word.text.strip())) for word in result.words)
            letters = sum(bool(re.fullmatch(r'\(?[ABCD]\)?', word.text.strip())) for word in result.words)
            # OCR may join several compact key entries into a single token.
            # Density proposes a page only; each cell still needs its own proof.
            entries = sum(len(re.findall(r'\d{1,3}\s*\(?[ABCD]\)?', word.text.strip()))
                          for word in result.words)
            compact = ('TEST_HEADER' in labels and 'SCORE_CONVERSION' not in labels
                       and numbers + entries >= 30 and compact_key_grid_candidate(layer, page))
            profile_candidate = page in profile_pages.get(row['sha256'], set()) and 'SCORE_CONVERSION' not in labels
            if key_page_candidate(numbers, letters, entries, labels) or compact or profile_candidate:
                from .key_tables import read_key_page, alignment
                # A conversion table has no per-question A-D cells. Density
                # only proposes a key page; the table parser must prove cells.
                for scope, expected in [('LISTENING', range(1, 101)), ('READING', range(101, 201))]:
                    blocks = read_key_page(layer, page, cache, expected)
                    for block in blocks:
                        proof = alignment(block, expected)
                        if proof['confirmed'] >= 50 and proof['orientation'] is not None:
                            key_tables.append({'scope': scope, **proof})
            current['searchedPages'][1] = page
            if page % 25 == 0 or page == layer.page_count:
                _write_json(report_path,
                            {'family': family, 'basis': index['basis'], 'sources': results + [current],
                             'scanState': 'IN_PROGRESS', 'ocrCache': cache.stats(), 'productionQualified': False})
        results.append(current)
        layer.doc.close()
    report = {'family': family, 'basis': index['basis'], 'sources': results, 'scanState': 'COMPLETE',
              'ocrCache': cache.stats(), 'productionQualified': False}
    _write_json(report_path, report)
    return report


def profile_key_candidates(index: dict) -> dict:
    """Known family windows propose cell reads even when full-page OCR misses tiny keys.

    Names select a search window only; printed test titles and every cell's
    own ordinal/lattice/letter checks still establish the actual key identity.
    A profile pinned to different source bytes cannot propose a window.
    """
    from .toeic_scan import PROFILES
    pages = {}
    for book, candidates in family_source_groups(index)['families'].items():
        profile = PROFILES.get(book)
        if profile is None:
            continue
        for source in candidates:
            scope = source['scopeCandidate']
            window = profile.key_pages.get(scope)
            pinned = profile.source_hashes.get(scope)
            if source['extension'] != '.pdf' or not window or (pinned and pinned != source['sha256']):
                continue
            pages.setdefault(source['sha256'], set()).update(range(window[0], window[1] + 1))
    return pages


def key_page_candidate(numbers: int, letters: int, entries: int, labels: list) -> bool:
    # Light scans can expose every ordinal while full-page detection misses the
    # tiny answer letters. An explicit answer heading plus ordinal density is
    # enough to propose a page for own-cell reads, never enough to bind keys.
    return ('SCORE_CONVERSION' not in labels and numbers + entries >= 30
            and (letters + entries >= 30 or 'ANSWER_KEY' in labels))


def compact_key_grid_candidate(layer, page: int) -> bool:
    """Physical compact grid under an inverse title proposes own-cell parsing."""
    from .layout import analyze_page, LayoutProfile, TEXT, INVERSE
    layout = analyze_page(layer, page, LayoutProfile(name='key-table-boundaries'))
    grids = [r.bbox for r in layout.regions if r.kind == TEXT and r.meta.get('lines', 0) >= 50]
    bars = [r.bbox for r in layout.regions if r.kind == INVERSE and r.meta.get('horizontal')]
    return any(0 <= grid[1] - bar[3] <= 25 and grid[0] >= bar[0] - 5 and grid[2] <= bar[2] + 5
               for grid in grids for bar in bars)


def inventory(raw_root: Path, output: Path, manifest_paths=()) -> dict:
    import pymupdf
    root = raw_root.resolve()
    hashes = HashCache(output / 'source-hashes.json')
    rows, members, errors = [], [], []
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        if not path.resolve().is_relative_to(root):
            errors.append({'code': 'RAW_SYMLINK_ESCAPES_ROOT', 'path': path.relative_to(root).as_posix()})
            continue
        rel = path.relative_to(root).as_posix()
        ext = path.suffix.lower()
        row = {'path': rel, 'family': family_of(rel), 'size': path.stat().st_size,
               'extension': ext, 'sha256': hashes.sha256(path), 'indexedInManifest': rel in manifest_paths}
        try:
            if ext == '.pdf':
                with pdf_diagnostics() as diagnostic:
                    with pymupdf.open(path) as doc:
                        row['pdf'] = inspect_pdf(doc)
                row['pdf']['diagnostics'] = diagnostic
            elif ext in ('.mp3', '.wav', '.m4a', '.ogg'):
                row['audio'] = {'durationSeconds': _probe_duration(str(path)),
                                'mime': MIME_BY_EXT.get(ext, 'audio/ogg'),
                                **inspect_audio_metadata(path)}
            elif ext == '.zip':
                with zipfile.ZipFile(path) as archive:
                    for member in archive.infolist():
                        if member.is_dir():
                            continue
                        member_ext = Path(member.filename).suffix.lower()
                        data = archive.read(member)
                        entry = {'archive': rel, 'member': member.filename, 'family': family_of(rel),
                                 'extension': member_ext, 'size': len(data),
                                 'sha256': hashlib.sha256(data).hexdigest()}
                        if member_ext == '.pdf':
                            with pdf_diagnostics() as diagnostic:
                                with pymupdf.open(stream=data, filetype='pdf') as doc:
                                    entry['pdf'] = inspect_pdf(doc)
                            entry['pdf']['diagnostics'] = diagnostic
                        elif member_ext in ('.mp3', '.wav', '.m4a', '.ogg'):
                            entry['audio'] = {'durationSeconds': _probe_duration(io.BytesIO(data)),
                                              'mime': MIME_BY_EXT.get(member_ext, 'audio/ogg'),
                                              **inspect_audio_metadata(io.BytesIO(data))}
                        members.append(entry)
        except Exception as exc:
            errors.append({'path': rel, 'code': 'SOURCE_INSPECTION_FAILED', 'exception': type(exc).__name__})
        rows.append(row)
    hashes.save()
    report = {'basis': 'ACTUAL_FILESYSTEM_AND_ARCHIVE_BYTES', 'rawRoot': 'imports/source-files',
              'files': rows, 'archiveMembers': members, 'errors': errors,
              'summary': {'files': len(rows), 'archiveMembers': len(members),
                          'families': dict(Counter(r['family'] for r in rows)),
                          'extensions': dict(Counter(r['extension'] for r in rows)),
                          'filesAbsentFromManifest': sum(not r['indexedInManifest'] for r in rows)},
              'rawSourceModified': False, 'productionQualified': False}
    _write_json(output / 'source-index.json', report)
    return report


def source_matrix(manifest, index: dict, staging: Path, output: Path) -> dict:
    from .toeic_scan import PROFILES
    files = {r['path']: r for r in index['files']}
    grouped = family_source_groups(index)
    _write_json(output / 'family-source-index.json', grouped)
    archives = {(r['archive'], r['member']): r for r in index['archiveMembers']}
    qualification = {}
    evidence_root = REPO_ROOT / 'docs/exams-production-verification/20261006'
    for evidence in sorted(evidence_root.glob('phase-b-*-qualification.json')):
        report = json.loads(evidence.read_text(encoding='utf-8'))
        if report.get('basis') != 'ISOLATED_TESTCONTAINER_OWNER_AUTHORIZED_LOCAL_ONLY':
            continue
        for result in report.get('results', []):
            if result.get('state') == 'LOCAL_OBJECTIVE_PIPELINE_PASS' and result.get('packageSha256'):
                key = (result['testId'], result['packageSha256'])
                qualification.setdefault(key, set()).add(result['scopeCode'])
    rows = []
    surveys = {}
    for family in ('ybm', 'economy'):
        surveys[family] = []
        for name in (f'{family}-back-matter.json', f'{family}-key-candidates.json'):
            path = staging / 'phase-b' / name
            if path.exists():
                surveys[family].extend(json.loads(path.read_text(encoding='utf-8')).get('sources', []))
        # A later cell/title probe may recover tables missed by the original
        # survey. Reconcile those actual-byte proofs into the family index;
        # the extractor still rereads every key before binding a package.
        for book in PROFILES:
            if not book.startswith(family + '-vol-'):
                continue
            for skill in ('LISTENING', 'READING'):
                path = staging / 'reports/ocr_keys' / f'{book}__{skill.lower()}.json'
                if not path.exists():
                    continue
                probe = json.loads(path.read_text(encoding='utf-8'))
                if probe.get('book') != book or probe.get('skill') != skill:
                    continue
                rel = probe.get('source', '').removeprefix('imports/source-files/')
                actual = files.get(rel)
                if actual is None or actual['sha256'] != probe.get('sha256'):
                    continue
                tables = [{**table, 'scope': skill, 'proofExtractorVersion': probe.get('extractorVersion')}
                          for table in probe.get('tests', []) if table.get('test') is not None
                          and table.get('orientation') is not None and table.get('confirmed', 0) >= 50]
                surveys[family].append({'path': rel, 'sha256': probe['sha256'], 'keyTables': tables})
    for test in manifest.tests:
        if test.collection not in ('ybm', 'economy'):
            continue
        docs = [d for d in test.book_raw.get('source_documents', [])
                if d.get('test_from_name') in (None, test.test_number)]
        family_candidates = [s for s in grouped['families'].get(test.book, [])
                             if s['testCandidate'] in (None, test.test_number)]
        questions_by_sha = {files[d['path']]['sha256']: files[d['path']] for d in docs if d['path'] in files}
        questions_by_sha.update({s['sha256']: s for s in family_candidates if s['roleCandidate'] == 'PDF_CANDIDATE'})
        questions = list(questions_by_sha.values())
        audio = [archives.get((a['source'], a['archive_member'])) if a.get('archive_member')
                 else files.get(a['source']) for a in test.raw.get('audio', [])]
        audio_by_sha = {a['sha256']: a for a in audio if a is not None}
        audio_by_sha.update({s['sha256']: s for s in family_candidates
                             if s['roleCandidate'] == 'AUDIO_CANDIDATE' and s['testCandidate'] == test.test_number})
        audio = list(audio_by_sha.values())
        extraction_path = staging / 'reports/extraction/toeic' / f'{test.book}__test-{test.test_number}.json'
        extraction = json.loads(extraction_path.read_text(encoding='utf-8')) if extraction_path.exists() else {}
        summary = extraction.get('summary', {})
        qualified_scopes = []
        package_path = extraction.get('package', {}).get('path')
        if package_path:
            current_package = (REPO_ROOT / package_path).resolve()
            if current_package.is_relative_to(staging.resolve()) and current_package.is_file():
                package_sha = hashlib.sha256(current_package.read_bytes()).hexdigest()
                qualified_scopes = sorted(qualification.get((test.test_id, package_sha), set()))
        parts = {f"PART_{m.group(1)}": p for s in summary.get('sections', []) for p in s.get('parts', [])
                 if (m := re.search(r'(?:^|_)PART_([1-7])$', p['code']))}
        profile = PROFILES.get(test.book)
        key_refs = []
        for d in docs:
            window = profile.key_pages.get(d.get('scope')) if profile else None
            if window and d['path'] in files:
                key_refs.append({'path': d['path'], 'sha256': files[d['path']]['sha256'],
                                 'pages': list(range(window[0], window[1] + 1)), 'scope': d.get('scope')})
        for source in surveys[test.collection]:
            # A source page is mapped only by its own proven test title and
            # current filesystem bytes. Unassigned grids stay discovery work.
            actual = files.get(source.get('path'))
            if (actual is None or actual['sha256'] != source.get('sha256')
                    or source['sha256'] not in {s['sha256'] for s in family_candidates}):
                continue
            for key in source.get('keyTables', []):
                if key.get('test') != test.test_number:
                    continue
                ref = {'path': source['path'], 'sha256': source['sha256'], 'pages': [key['page']],
                       'scope': key['scope'], 'confirmedCells': key['confirmed'],
                       'testIdentityProof': 'PRINTED_KEY_TABLE_TITLE'}
                if ref not in key_refs:
                    key_refs.append(ref)
        row = {'FORM': test.test_id, 'FAMILY': test.book,
               'FILESYSTEM_FAMILY_SOURCES': [s['sourceIdentity'] for s in grouped['families'].get(test.book, [])
                                             if s['testCandidate'] in (None, test.test_number)],
               'QUESTION_SOURCE_PRESENT': bool(questions),
               'KEY_SOURCE_PRESENT': True if key_refs else None,
               'KEY_SOURCE_STATUS': ('LOCATED_PRINTED_TEST_CELL_PROOF' if any('confirmedCells' in k for k in key_refs)
                                     else 'LOCATED_PROFILE_PENDING_CELL_PROOF' if key_refs else 'OWNER_CONFIRMED_DISCOVERY_OPEN'),
               'AUDIO_SOURCE_PRESENT': bool(audio),
               'QUESTION_SOURCES': [q.get('path') or q['archive'] + '::' + q['member'] for q in questions],
               'KEY_SOURCES': key_refs,
               'AUDIO_SOURCES': [{'path': a.get('path') or a['archive'] + '::' + a['member'],
                                  'sha256': a['sha256'], **a.get('audio', {}),
                                  'productionStorageBinding': 'UNVERIFIED'} for a in audio],
               'EXTRACTED_QUESTION_COUNT': summary.get('itemsEmitted', 0),
               'EXTRACTED_KEY_COUNT': summary.get('answerKeysBound', 0),
               'RECOVERED_KEY_COUNT': sum(k.get('keysParsed', 0) for k in extraction.get('answerKeys', [])),
               'EXTRACTED_AUDIO_BINDINGS': sum(len(p.get('audio', [])) for p in parts.values()),
               **{f'PART{n}': {'questions': parts.get(f'PART_{n}', {}).get('items', 0),
                              'keys': sum(g.get('keysBound', 0) for g in parts.get(f'PART_{n}', {}).get('groups', []))}
                  for n in range(1, 8)},
               'QUALIFICATION_RESULT': 'LOCAL_OBJECTIVE_PIPELINE_PASS' if qualified_scopes else 'NOT_RUN_PHASE_B',
               'QUALIFIED_SCOPE_CODES': qualified_scopes,
               'EXTRACTION_VERSION': extraction.get('extractor', {}).get('version'),
               'BLOCKER': sorted({d['code'] for d in extraction.get('diagnostics', []) if d['severity'] == 'BLOCKING'}),
               'DISPOSITION': 'PIPELINE_RECOVERY_OPEN'}
        rows.append(row)
    report = {'basis': index['basis'], 'forms': rows, 'totalForms': len(rows),
              'hardSourceBlocksProven': 0, 'productionQualified': False}
    _write_json(output / 'ybm-economy-source-matrix.json', report)
    return report


def run_source_index(args, staging: Path) -> int:
    manifest = RawCorpusManifest()
    output = staging / 'phase-b'
    scan_family = getattr(args, 'scan_family', None)
    refresh_family = getattr(args, 'refresh_cached_family', None)
    prior = output / 'source-index.json'
    index = (json.loads(prior.read_text(encoding='utf-8')) if (scan_family or refresh_family) and prior.exists()
             else inventory(RAW_ROOT, output, manifest.files))
    if scan_family:
        scan_back_matter(index, scan_family, staging)
    if refresh_family:
        survey_path = output / f'{refresh_family}-back-matter.json'
        survey = json.loads(survey_path.read_text(encoding='utf-8'))
        completed = {s['sha256'] for s in survey['sources'] if s.get('sha256') and
                     any(r['sha256'] == s['sha256'] and s.get('searchedPages', [0, 0])[1] == r.get('pdf', {}).get('pages')
                         for r in index['files'])}
        subset = {**index, 'files': [r for r in index['files'] if r['sha256'] in completed]}
        name = f'{refresh_family}-key-candidates.json'
        report = scan_back_matter(subset, refresh_family, staging, name)
        report.update(scanBasis='COMPLETED_SURVEY_SOURCES_ONLY', familyScanComplete=False)
        _write_json(output / name, report)
    matrix = source_matrix(manifest, index, staging, output)
    print(json.dumps({**index['summary'], 'matrixForms': matrix['totalForms'],
                      'errors': len(index['errors'])}, indent=1))
    return 0
