"""Source-backed TOEIC Part validation and mandatory full release when all Parts exist."""
import re
from .toeic import FORMATS


def assert_complete_source_package(pkg):
    assert_valid_source_parts(pkg, require_full=True)


def assert_valid_source_parts(pkg, require_full=False, require_audio=True):
    identity = pkg['manifest'].get('metadata', {}).get('sourceIdentity', {})
    if identity.get('collection') not in ('ybm', 'economy'):
        return
    formats = {s.get('blueprint', {}).get('formatVersion') for s in pkg['specifications']
               if s.get('family') == 'TOEIC'}
    assert len(formats) == 1 and next(iter(formats)) in FORMATS, 'TOEIC_FORMAT_UNPROVEN'
    blueprint = FORMATS[next(iter(formats))]
    sections = {s['id']: s['skill'] for s in pkg['sections']}
    if require_full:
        assert sorted(sections.values()) == ['LISTENING', 'READING'], 'FULL_TOEIC_SECTIONS_REQUIRED'
    parts = pkg['parts']
    numbers = [p['timingPolicy']['partNumber'] for p in parts]
    assert numbers and len(set(numbers)) == len(numbers) and all(n in blueprint for n in numbers), 'TOEIC_PART_IDENTITY_REQUIRED'
    if require_full:
        assert sorted(numbers) == list(range(1, 8)), 'FULL_TOEIC_PARTS_REQUIRED'
    answers = {s['itemId']: s for s in pkg['answerSpecs']}
    stimuli = {s['id']: s for s in pkg['stimuli']}
    assets = {a['id']: a for a in pkg['assets']}
    total = 0
    for part in parts:
        number = part['timingPolicy']['partNumber']
        assert sections[part['sectionId']] == ('LISTENING' if number <= 4 else 'READING')
        placements = [g for g in pkg['formGroups'] if g['partId'] == part['id']]
        found = []
        part_audio = False
        for placement in sorted(placements, key=lambda g: g['ordinal']):
            group_id = placement['groupId']
            items = sorted((i for i in pkg['items'] if i['groupId'] == group_id), key=lambda i: i['ordinal'])
            for item in items:
                match = re.search(r'[RL](\d+)$', item['logicalItemKey'])
                assert match, 'PRINTED_QUESTION_ID_REQUIRED'
                found.append(int(match.group(1)))
                assert item['prompt'].strip() and item['id'] in answers, 'QUESTION_OR_KEY_MISSING'
                values = answers[item['id']]['acceptedAnswers'].get('values', [])
                option_ids = {o['id'] for o in item['optionDefinitions'].get('options', [])}
                assert len(values) == 1 and values[0] in option_ids, 'ANSWER_OPTION_MAPPING_FAILED'
            refs = [g['stimulusId'] for g in pkg['groupStimuli'] if g['groupId'] == group_id]
            if number >= 6:
                assert refs and any(stimuli[r].get('bodyPayload') for r in refs), 'PASSAGE_ATTACHMENT_REQUIRED'
            asset_ids = [a['assetId'] for a in pkg['stimulusAssets'] if a['stimulusId'] in refs]
            assert all(a in assets for a in asset_ids), 'ASSET_BINDING_MISSING'
            bound_assets = [assets[a] for a in asset_ids]
            part_audio |= any(a.get('mimeType', '').startswith('audio/') and a.get('validationState') == 'VALIDATED'
                              for a in bound_assets)
        lo, hi = blueprint[number]
        assert found == list(range(lo, hi + 1)), f'PART_{number}_INCOMPLETE:{len(found)}'
        if number <= 4 and require_audio:
            assert part_audio, f'PART_{number}_AUDIO_REQUIRED'
        total += len(found)
    if require_full:
        assert total == 200, 'FULL_TOEIC_200_REQUIRED'
