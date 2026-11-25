"""Prepare finite source-checked spelling recordings using the EXISTING local OmniVoice.

Explicit operator invocation only. No model import, provider credentials, startup job or
production database access. Existing complete files are hash checked and reused.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import time
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'backend/src/main/resources/data/spelling'
GROUPS = [
    '''ocean garden apple banana orange lemon cherry coconut carrot potato tomato onion
    pepper chicken rabbit kitten puppy elephant dolphin turtle monkey tiger zebra giraffe
    penguin butterfly spider insect flower forest mountain river island desert valley cloud
    thunder rainbow winter summer autumn morning evening family mother father sister brother
    cousin uncle grandmother kitchen bedroom window curtain carpet blanket pillow basket
    bottle bucket pencil notebook classroom teacher student lesson library hospital airport
    station bicycle engine tractor helmet jacket sweater pocket button mitten necklace
    bracelet dinner breakfast sandwich chocolate cookie biscuit honey butter cheese yogurt
    music guitar trumpet violin piano camera picture mirror letter number circle square
    yellow purple silver golden happy hungry thirsty little middle gentle quiet clever''',
    '''adventure journey compass harbour waterfall volcano glacier jungle orchard meadow
    squirrel leopard flamingo crocodile octopus jellyfish kangaroo dinosaur mosquito
    cucumber broccoli spinach pumpkin apricot avocado pineapple cinnamon lemonade restaurant
    recipe ingredient vegetable furniture cupboard wardrobe balcony chimney staircase
    ceiling curtain cushion calendar envelope scissors dictionary paragraph sentence
    grammar language exercise revision homework education university laboratory experiment
    microscope telescope astronaut satellite planet galaxy gravity energy electricity
    battery computer keyboard internet software website message conversation question
    answer opinion reason example knowledge memory attention patience courage friendship
    kindness honesty freedom success progress imagine discover explore create describe
    explain improve achieve develop arrange collect protect promise remember understand
    surprise curious nervous careful generous confident comfortable dangerous beautiful''',
    '''accommodation achievement acquaintance acknowledge administration adolescence advantage
    advertisement agriculture alternative anniversary anonymous architecture atmosphere
    appropriate archaeology artificial association audience authority available awareness
    bankruptcy beneficial biodiversity bureaucracy catastrophe characteristic chronology
    collaboration colleague commitment communication community competition comprehensive
    conscience conscientious consequence conservation consistent constitution contemporary
    controversy convenient coordination courageous curriculum democracy determination
    development diagnostic disappearance discipline distinguish embarrassment enthusiasm
    environment exaggeration exceptional existence experience extraordinary fascinating
    fluorescent foreign frequently guarantee hierarchy hypothesis immediately independent
    indispensable inevitable infrastructure intelligence interpretation investigation
    irresistible laboratory magnificent maintenance mathematics Mediterranean miscellaneous
    mysterious necessary negotiation neighbour opportunity organisation perseverance
    phenomenon philosophy picturesque possession potential pronunciation psychology
    questionnaire recommendation refrigerator responsibility rhythm scientific simultaneous
    sophisticated spectacular strategy sufficient temperature theoretically thorough
    tremendous unfortunately unique vocabulary vulnerable wilderness wonderful''',
]
PHRASES = {
    'start': "Welcome to Echo Spelling. Listen carefully, and let the competition begin!",
    'contestant': "Our next contestant, please step up to the microphone.",
    'correct': "That is correct! Beautiful spelling.",
    'wrong': "Not quite this time. Keep learning, and try again.",
    'timeout': "Time is up. Let's look at the spelling together.",
    'next': "Well done. Here comes your next word.",
    'winner': "We have a winner! Congratulations, Echo champion!",
    'record': "A new personal best! What a wonderful achievement!",
    'finish': "Challenge complete. Let's see how you did.",
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--limit', type=int, default=330)
    args = parser.parse_args()
    source = ROOT / 'backend/src/main/resources/data/king/corpus/king-core.sqlite.gz'
    db = sqlite3.connect(':memory:')
    db.deserialize(gzip.decompress(source.read_bytes()))
    eligible = {row[0]: 'king-core.lexicon:' + row[0] for row in db.execute('SELECT word FROM lexicon')}
    for item_id, raw in db.execute('SELECT id,body FROM content'):
        content = json.loads(raw)['content']
        for field in ('lemma', 'canonical', 'target'):
            value = content.get(field, '')
            if value.isalpha():
                eligible.setdefault(value.lower(), 'king-core.content:' + item_id + ':' + field)
    db.close()
    words, seen, rejected = [], set(), []
    for tier, group in enumerate(GROUPS):
        for word in group.lower().split():
            if word in seen:
                continue
            if word not in eligible or word == 'desert':
                rejected.append(word)
                continue
            seen.add(word)
            clue = {'flower': 'A blossom on a plant.', 'morning': 'The early part of the day.',
                    'station': 'A place where trains stop.', 'muscle': 'Body tissue that creates movement.'}.get(word, '')
            words.append({'word': word, 'tier': tier, 'source': eligible[word], 'clue': clue})
    if min(sum(w['tier'] == tier for w in words) for tier in range(3)) < 70:
        raise RuntimeError('Insufficient source-qualified vocabulary')
    DEST.mkdir(parents=True, exist_ok=True)
    manifest_path = DEST / 'catalog.json'
    previous = json.loads(manifest_path.read_text('utf-8')) if manifest_path.exists() else {}
    by_text = {a['text']: a for a in previous.get('audio', [])}
    manifest = {'version': 'echo-spelling-1', 'voice': 'us_female', 'language': 'en-US',
                'provider': 'existing-local-OmniVoice', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'difficultyBasis': 'Editorial spelling challenge tiers; not CEFR certification',
                'words': words, 'phrases': PHRASES, 'audio': []}
    targets = [(w['word'], ('The word is ' + w['word'] + '. ' + w['clue']).strip()) for w in words]
    targets += list(PHRASES.items())
    print(json.dumps({'eligible': len(words), 'tiers': [sum(w['tier'] == t for w in words) for t in range(3)],
                      'excludedNotInSource': rejected, 'generate': args.generate}), flush=True)
    audio_dir = DEST / 'audio'
    audio_dir.mkdir(exist_ok=True)
    generated = 0
    for index, (key, text) in enumerate(targets):
        token = hashlib.sha256(('echo-spelling-1:us_female:en-US:' + text).encode()).hexdigest()
        path = audio_dir / (token + '.wav')
        old = by_text.get(text)
        valid = old and path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == old['sha256']
        if not valid and args.generate and generated < args.limit:
            request = urllib.request.Request('http://127.0.0.1:8005/tts/omnivoice',
                data=json.dumps({'voiceId': 'us_female', 'text': text}).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            started = time.monotonic()
            with urllib.request.urlopen(request, timeout=100) as response:
                data = response.read(4 * 1024 * 1024)
            with wave.open(io.BytesIO(data), 'rb') as wav:
                duration = round(wav.getnframes() / wav.getframerate() * 1000)
                if not 350 <= duration <= 18000 or wav.getnchannels() > 2:
                    raise RuntimeError('Invalid OmniVoice WAV: ' + key)
            path.write_bytes(data)
            old = {'key': key, 'text': text, 'file': token + '.wav', 'durationMs': duration,
                   'sha256': hashlib.sha256(data).hexdigest(), 'generationMs': round((time.monotonic()-started)*1000)}
            generated += 1
        if old:
            manifest['audio'].append(old)
        # Atomic, resumable preparation: never claim all recordings exist before they do.
        temp = manifest_path.with_suffix('.pending')
        temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temp.replace(manifest_path)
        if (index + 1) % 10 == 0:
            print(json.dumps({'prepared': len(manifest['audio']), 'total': len(targets), 'last': key}), flush=True)
    print(json.dumps({'recordings': len(manifest['audio']), 'required': len(targets), 'generated': generated}), flush=True)

if __name__ == '__main__':
    main()
