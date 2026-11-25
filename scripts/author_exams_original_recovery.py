"""Author distinct immutable original practice packages; seal with the Java validator.

No database access and no publisher corpus changes. The Academic chart is reused
byte-for-byte from the existing EnglishCoach original source.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import uuid
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'content/exams/original-pilot/IELTS'
OUT = ROOT / 'backend/src/main/resources/exams/original-practice'
NS = uuid.UUID('7b72e4b6-11af-46eb-9f77-815a810a6caf')

def package(template, key, title):
    data = json.loads((SOURCE / template).read_text(encoding='utf-8'))
    def replace(value):
        if isinstance(value, dict): return {k: replace(v) for k, v in value.items()}
        if isinstance(value, list): return [replace(v) for v in value]
        if isinstance(value, str) and re.fullmatch(r'[0-9a-fA-F-]{36}', value):
            return str(uuid.uuid5(NS, key + ':' + value))
        return value
    data = replace(data)
    data['manifest'].update(packageId=key, packageVersion=1, creator='ENGLISHCOACH_ORIGINAL_RECOVERY',
        createdAt='2026-10-06T00:00:00Z', contentHash='0' * 64,
        metadata={'provenanceLabel': 'EnglishCoach Original IELTS Practice',
                  'ownerAuthorizedOriginalPractice': '2026-10-06', 'humanReviewComplete': False,
                  'officialIELTS': False, 'publisherEndorsement': False})
    data['form'].update(logicalKey=key, version=1, title=title, lifecycleState='DRAFT')
    data['catalogNodes'][0]['title'] = 'EnglishCoach Original IELTS Practice'
    data['sources'][0].update(code=key + '_SOURCE', name='EnglishCoach Original IELTS Practice')
    data['sources'][0]['referenceMeta'] = {'declaration': 'Original practice; no publisher content or endorsement.'}
    data['licenses'][0].update(licenseCode=key + '_ORIGINAL_PENDING', attribution='EnglishCoach Original IELTS Practice; human review pending')
    data['provenances'][0].update(creator='ENGLISHCOACH_ORIGINAL_RECOVERY', originalReference=key)
    data['provenances'][0]['aiGenerationMeta'] = {'generatedAt': '2026-10-06', 'humanReviewComplete': False}
    for section in data['sections']:
        section.update(isRunnable=True, healthStatus='HEALTHY')
    # Every dependency belongs to this new closure; logical identities must be distinct too.
    for rows in ('specifications', 'rubrics', 'scoringSchemes', 'groups', 'stimuli', 'items'):
        for row in data[rows]:
            for k in ('logicalCode', 'logicalGroupKey', 'logicalStimulusKey', 'logicalItemKey'):
                if k in row:
                    identity = key + '_' + row[k]
                    # Specification/rubric/scoring logical codes are VARCHAR(64).
                    # Keep deterministic distinct identities within that schema.
                    suffix = re.search(r'_Q\d+$', identity)
                    row[k] = key + '_' + hashlib.sha256(identity.encode()).hexdigest()[:12] + (suffix.group(0) if suffix else '') if len(identity) > 64 else identity
    return data

def write(data):
    for asset in data['assets']:
        original = ROOT / 'content/exams/original-pilot' / asset['objectKey']
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        relative = 'assets/recovery20261006/' + digest + original.suffix
        target = ROOT / 'content/exams/original-pilot' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists(): shutil.copyfile(original, target)
        assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
        asset.update(objectKey=relative, sha256Hash=digest, byteSize=len(target.read_bytes()))
    # Row hashes describe the actual new content. The package envelope is sealed by Java.
    for rows in ('specifications', 'rubrics', 'scoringSchemes', 'groups', 'stimuli', 'items'):
        for row in data[rows]:
            row['contentHash'] = hashlib.sha256(json.dumps({k: v for k, v in row.items() if k != 'contentHash'}, sort_keys=True).encode()).hexdigest()
    data['form']['contentHash'] = hashlib.sha256(json.dumps(data['items'], sort_keys=True).encode()).hexdigest()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / (data['manifest']['packageId'] + '.json')).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

acad = package('IELTS_ACAD_WRITING_PILOT_001_V1.json', 'EC_ORIGINAL_IELTS_ACADEMIC_WRITING_20261006',
               'EnglishCoach Original IELTS Academic Writing - Renewable energy')
acad['items'][0]['prompt'] = 'The chart shows invented practice data for investment in four renewable energy sectors in 2015, 2020 and 2025, in billions of US dollars. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.'
acad['items'][1]['prompt'] = 'Some people believe that governments should invest more in improving public transport, while others think that building roads is the better priority. Discuss both views and give your own opinion. Write at least 250 words.'
acad['groups'][1]['topic'] = 'public transport and roads'
acad['stimuli'][1]['bodyPayload'] = {'prompt': acad['items'][1]['prompt']}
acad['answerSpecs'][1]['acceptedAnswers']['requiredActs'] = ['Discuss both transport priorities', 'Give and support your own opinion']
acad['assets'][0]['validationState'] = 'VALIDATED'
chart = ROOT / 'content/exams/original-pilot/assets/ielts_acad_w_task1_chart.svg'
acad['assets'][0]['sha256Hash'] = hashlib.sha256(chart.read_bytes()).hexdigest()
acad['assets'][0]['byteSize'] = len(chart.read_bytes())
write(acad)

gt = package('IELTS_GT_WRITING_PILOT_001_V1.json', 'EC_ORIGINAL_IELTS_GT_WRITING_20261006',
             'EnglishCoach Original IELTS General Training Writing - Community library')
gt['items'][0]['prompt'] = 'A library near your home is planning to change its opening hours. Write a letter to the library manager. In your letter, explain how you use the library, describe a problem the proposed hours would cause, and suggest an alternative. Write at least 150 words. You do not need to write any addresses. Begin your letter: Dear Sir or Madam,'
gt['items'][1]['prompt'] = 'Some people think that learning practical skills at school is more useful than studying traditional academic subjects. To what extent do you agree or disagree? Write at least 250 words.'
for i, row in enumerate(gt['stimuli']): row['bodyPayload'] = {'prompt': gt['items'][i]['prompt']}
for i, row in enumerate(gt['answerSpecs']): row['acceptedAnswers'] = {'policy': 'productive_response', 'minimumWords': 150 if i == 0 else 250}
write(gt)

sp = package('IELTS_SHARED_SPEAKING_PILOT_001_V1.json', 'EC_ORIGINAL_IELTS_SPEAKING_20261006',
             'EnglishCoach Original IELTS Speaking - A useful shared place')
prompts = [
 ['What kind of area do you live in?', 'Is there a public place near your home that you use often?', 'Do you prefer quiet places or busy places in your free time? Why?', 'Has the area where you live changed in recent years?'],
 ['Describe a shared place that became more useful after a small improvement. You should say: where the place is, what was changed, who uses it, and explain why the improvement made a difference.'],
 ['Why can a small improvement to a public place have a large effect on a community?', 'How should local authorities decide which public spaces need investment?', 'What are the advantages and disadvantages of asking residents to help design shared places?', 'How might the way people use public places change in the future?']]
items, answers = [], []
for part, bank in enumerate(prompts):
    base = sp['items'][part]
    answer = sp['answerSpecs'][part]
    sp['stimuli'][part]['bodyPayload'] = {'text': 'EnglishCoach Original IELTS Speaking Practice'}
    for index, prompt in enumerate(bank):
        item = copy.deepcopy(base)
        item.update(id=str(uuid.uuid5(NS, sp['manifest']['packageId'] + f':item:{part}:{index}')),
                    prompt=prompt, ordinal=index + 1, logicalItemKey=sp['manifest']['packageId'] + f'_P{part+1}_Q{index+1}')
        a = copy.deepcopy(answer)
        a.update(id=str(uuid.uuid5(NS, item['id'] + ':answer')), itemId=item['id'],
                 acceptedAnswers={'policy': 'productive_response'}, explanation='Response-only original practice; no official IELTS score.')
        items.append(item); answers.append(a)
sp['items'], sp['answerSpecs'] = items, answers
sp['manifest']['metadata']['targetItemCount'] = 9
sp['specifications'][0]['blueprint']['itemCount'] = 9
sp['specifications'][0]['blueprint']['targetItemCount'] = 9
write(sp)
print('AUTHORED_ORIGINAL_PACKAGES=3; PACKAGE_HASHES_REQUIRE_JAVA_SEAL')

# Reuse the authored original objective pilots, correcting their missing printed
# numbering in new identities. No historical/publisher item or key is changed.
for template, key, title in [
 ('IELTS_SHARED_LISTENING_PILOT_001_V2.json', 'EC_ORIGINAL_IELTS_LISTENING_20261006', 'EnglishCoach Original IELTS Listening Practice'),
 ('IELTS_ACAD_READING_PILOT_001_V2.json', 'EC_ORIGINAL_IELTS_READING_20261006', 'EnglishCoach Original IELTS Reading Practice')]:
    obj = package(template, key, title)
    if 'READING' in key:
        base_part = obj['parts'][0]
        obj['parts'] = []
        for index, placement in enumerate(obj['formGroups'], 1):
            part = copy.deepcopy(base_part)
            part.update(id=str(uuid.uuid5(NS, key + f':passage:{index}')), partCode=f'READING_PASSAGE_{index}', ordinal=index)
            obj['parts'].append(part)
            placement.update(partId=part['id'], ordinal=1)
    for item in obj['items']:
        match = re.search(r'_Q(\d+)$', item['logicalItemKey'])
        assert match, item['logicalItemKey']
        item['ordinal'] = int(match.group(1))
        item['optionDefinitions']['questionNumber'] = item['ordinal']
    for asset in obj['assets']:
        asset_file = ROOT / 'content/exams/original-pilot' / asset['objectKey']
        assert asset_file.is_file(), asset_file
        asset['sha256Hash'] = hashlib.sha256(asset_file.read_bytes()).hexdigest()
        asset['byteSize'] = len(asset_file.read_bytes())
    write(obj)

lr = package('../TOEIC/TOEIC_LR_PILOT_001_V2.json', 'EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006',
             'EnglishCoach Original TOEIC Listening & Reading Practice - Parts 2, 5 and 7')
lr['sources'][0]['name'] = 'EnglishCoach Original TOEIC Listening & Reading Practice'
lr['parts'] = [p for p in lr['parts'] if p['partCode'].endswith(('_2', '_5', '_7'))]
part_ids = {p['id'] for p in lr['parts']}
lr['formGroups'] = [g for g in lr['formGroups'] if g['partId'] in part_ids]
group_ids = {g['groupId'] for g in lr['formGroups']}
lr['groups'] = [g for g in lr['groups'] if g['id'] in group_ids]
lr['items'] = [i for i in lr['items'] if i['groupId'] in group_ids]
lr['specifications'][0]['blueprint']['itemCount'] = len(lr['items'])
lr['specifications'][0]['blueprint']['targetItemCount'] = len(lr['items'])
item_ids = {i['id'] for i in lr['items']}
lr['answerSpecs'] = [a for a in lr['answerSpecs'] if a['itemId'] in item_ids]
lr['groupStimuli'] = [g for g in lr['groupStimuli'] if g['groupId'] in group_ids]
stimulus_ids = {g['stimulusId'] for g in lr['groupStimuli']}
lr['stimuli'] = [s for s in lr['stimuli'] if s['id'] in stimulus_ids]
for stimulus in lr['stimuli']:
    text = stimulus.get('bodyPayload', {}).get('text', '')
    if '[DOCUMENT 2:' in text:
        # Preserve explicitly authored document boundaries; never infer new documents.
        documents = []
        for segment in re.split(r'(?=\[DOCUMENT \d+:)', text):
            match = re.match(r'\[DOCUMENT \d+: ([^\]]+)\]\s*([\s\S]*)', segment)
            if match: documents.append({'title': match.group(1), 'text': match.group(2).rstrip('-\n')})
        assert len(documents) >= 2
        stimulus['kind'] = 'MULTI_DOC'
        stimulus['bodyPayload'] = {'text': text, 'documents': documents}
lr['assets'], lr['stimulusAssets'] = [], []
for section in lr['sections']: section['ordinal'] += 1
for part in lr['parts']: part['ordinal'] = int(part['partCode'][-1])
for g in lr['formGroups']: g['ordinal'] += 1
for item in lr['items']:
    match = re.search(r'_Q(\d+)$', item['logicalItemKey'])
    assert match, item['logicalItemKey']
    item['ordinal'] = int(match.group(1))
    item['optionDefinitions']['questionNumber'] = item['ordinal']
audio_script = ['EnglishCoach original TOEIC Part 2 practice. Listen to each question and choose the best response.']
part2 = next(p['id'] for p in lr['parts'] if p['partCode'].endswith('_2'))
part2_groups = {g['groupId'] for g in lr['formGroups'] if g['partId'] == part2}
part2_stimuli = {g['stimulusId'] for g in lr['groupStimuli'] if g['groupId'] in part2_groups}
audio_id = str(uuid.uuid5(NS, 'toeic-part2-audio-20261006'))
for index, stimulus in enumerate(s for s in lr['stimuli'] if s['id'] in part2_stimuli):
    body = stimulus['bodyPayload']
    assert body.get('spokenPrompt') and len(body.get('spokenResponses', [])) == 3
    audio_script.extend([f'Question {index+7}.', body['spokenPrompt'], *body['spokenResponses'], '          '])
    stimulus['kind'] = 'AUDIO'
    # Transcript remains internal; the learner sanitizer drops AUDIO bodies.
    stimulus['bodyPayload'] = {'transcript': body['spokenPrompt'] + ' ' + ' '.join(body['spokenResponses'])}
    lr['stimulusAssets'].append(dict(id=str(uuid.uuid5(NS, stimulus['id']+':audio')),
        stimulusId=stimulus['id'], assetId=audio_id, role='PRIMARY_AUDIO', ordinal=1))
script_path = ROOT / 'docs/exams-production-verification/20261006/toeic-original-audio-script.txt'
script_path.write_text('\n'.join(audio_script), encoding='utf-8')
audio = ROOT / 'content/exams/original-pilot/assets/toeic_original_part2_20261006.wav'
if audio.exists():
    import wave
    with wave.open(str(audio)) as wav: duration = round(wav.getnframes()/wav.getframerate()*1000)
    lr['assets'] = [dict(id=audio_id, provenanceId=lr['form']['provenanceId'], objectKey='assets/'+audio.name,
        versionId='1', sha256Hash=hashlib.sha256(audio.read_bytes()).hexdigest(), mimeType='audio/wav',
        byteSize=len(audio.read_bytes()), durationMs=duration, dimensions=None, validationState='VALIDATED', createdAt=None)]
    write(lr)
print('OBJECTIVE_ORIGINAL_PILOTS_AUTHORED; TOEIC_AUDIO_REQUIRED_FOR_SEAL')
