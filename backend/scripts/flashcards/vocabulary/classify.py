"""Step 2 — topic draft from WordNet evidence (owner brief 2026-10-30).

Each aligned card gets at most ONE draft deck from the lexicographer file and hypernym chain of the WordNet sense of its
part of speech. Words no rule claims stay unassigned (never a "General" deck). The draft is then reviewed by hand:
`review.json` removes misplaced words, moves words to the right deck and records why (see build.py).

usage: python classify.py <aligned.json> <draft.json>
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

from align import IRREGULAR

# deck slug -> ordered rules; a rule = (lexfiles, hypernym keywords). Empty keywords = the whole lexfile.
RULES = [
    ('topic-food-drinks', [({'noun.food'}, ()), ({'verb.consumption'}, ()),
                           ({'noun.artifact'}, ('kitchen_utensil', 'cutlery', 'tableware', 'crockery', 'cookware', 'dish-n',
                                                'kitchenware', 'cooking_utensil', 'drinking_vessel')),
                           ({'noun.plant'}, ('vegetable', 'edible_fruit', 'fruit-n', 'herb-n', 'edible_nut')),
                           ({'verb.creation', 'verb.change'}, ('cook-v', 'heat-v', 'fry-v', 'bake-v'))]),
    ('topic-body-health', [({'noun.body'}, ()), ({'verb.body'}, ()),
                           ({'noun.state'}, ('illness', 'disease', 'symptom', 'pain-n', 'injury', 'physical_condition',
                                             'pathological_state', 'ill_health', 'disorder')),
                           ({'noun.artifact'}, ('drug-n', 'medicine-n', 'medical_instrument', 'bandage')),
                           ({'noun.act'}, ('medical_care', 'treatment', 'therapy', 'surgery')),
                           ({'noun.person'}, ('medical_practitioner', 'health_professional', 'patient-n'))]),
    ('topic-animals', [({'noun.animal'}, ())]),
    ('topic-nature-weather', [({'noun.plant'}, ()), ({'noun.object'}, ()), ({'verb.weather'}, ()),
                              ({'noun.phenomenon'}, ('weather', 'atmospheric_phenomenon', 'precipitation', 'wind-n',
                                                     'natural_phenomenon', 'storm', 'light-n')),
                              ({'noun.location'}, ('geological_formation', 'body_of_water', 'land-n')),
                              ({'noun.substance'}, ('soil', 'rock-n', 'water-n', 'mineral'))]),
    ('topic-family-people', [({'noun.person'}, ('relative-n', 'kin-n', 'family-n', 'spouse', 'parent-n', 'child-n',
                                                'offspring', 'sibling', 'friend', 'lover', 'adult-n', 'juvenile',
                                                'female-n', 'male-n', 'acquaintance', 'neighbor')),
                             ({'noun.group'}, ('family-n', 'kin_group'))]),
    ('topic-jobs-work', [({'noun.person'}, ('worker-n', 'professional-n', 'employee', 'skilled_worker', 'leader-n',
                                            'expert', 'creator-n', 'serviceman', 'official-n', 'businessperson',
                                            'scientist', 'artist', 'performer', 'communicator', 'intellectual')),
                         ({'noun.act'}, ('occupation', 'job-n', 'work-n', 'employment', 'labor-n')),
                         ({'noun.group'}, ('business-n', 'enterprise', 'company', 'organization-n', 'institution'))]),
    ('topic-home', [({'noun.artifact'}, ('furniture', 'furnishing', 'room-n', 'home_appliance', 'appliance', 'bedclothes',
                                         'bed-n', 'house-n', 'dwelling', 'housing', 'door-n', 'window-n', 'wall-n',
                                         'lamp-n', 'container-n', 'box-n', 'bag-n', 'tool-n', 'hand_tool',
                                         'implement-n', 'cleaning_implement', 'toiletry', 'fixture', 'roof')),
                    ({'verb.contact', 'verb.change'}, ('clean-v', 'wash-v', 'sweep-v'))]),
    ('topic-clothing', [({'noun.artifact'}, ('clothing', 'garment', 'footwear', 'headdress', 'jewelry', 'accessory',
                                             'covering-n-2', 'cloth-n', 'fabric', 'apparel')),
                        ({'verb.body'}, ('dress-v', 'wear-v'))]),
    ('topic-transport-travel', [({'noun.artifact'}, ('vehicle', 'conveyance', 'craft-n', 'aircraft', 'ship', 'boat',
                                                     'motor_vehicle', 'car-n', 'road-n', 'way-n', 'bridge', 'station',
                                                     'airport', 'track-n', 'transport')),
                                ({'verb.motion'}, ('travel-v', 'drive-v', 'ride-v', 'fly-v', 'go-v', 'arrive', 'leave-v')),
                                ({'noun.act'}, ('journey', 'travel-n', 'trip-n', 'voyage')),
                                ({'noun.person'}, ('traveler', 'passenger', 'driver'))]),
    ('topic-city-places', [({'noun.artifact'}, ('building', 'structure-n', 'establishment', 'facility', 'shop-n',
                                                'place_of_business', 'restaurant', 'hotel', 'school-n', 'hospital',
                                                'church', 'theater', 'park', 'museum', 'library')),
                           ({'noun.location'}, ('city', 'town', 'municipality', 'urban_area', 'district', 'street',
                                                'area-n', 'region-n', 'point-n', 'country', 'state-n'))]),
    ('topic-emotions', [({'noun.feeling'}, ()), ({'verb.emotion'}, ())]),
    ('topic-sports-hobbies', [({'noun.act'}, ('sport', 'game-n', 'athletics', 'contest', 'diversion', 'recreation',
                                              'exercise', 'play-n', 'hobby', 'dance-n', 'swimming')),
                              ({'verb.competition'}, ()),
                              ({'noun.artifact'}, ('sports_equipment', 'game_equipment', 'ball-n', 'toy')),
                              ({'noun.person'}, ('athlete', 'player-n', 'contestant'))]),
    ('topic-music-arts', [({'noun.artifact'}, ('musical_instrument', 'work_of_art', 'art-n', 'picture-n', 'painting')),
                          ({'noun.communication'}, ('music-n', 'musical_composition', 'song', 'literary_composition',
                                                    'writing_style', 'fiction', 'poem', 'novel', 'drama', 'film')),
                          ({'noun.act'}, ('art-n', 'performance', 'show-n', 'creation-n')),
                          ({'noun.person'}, ('musician', 'singer', 'painter', 'writer', 'actor'))]),
    ('topic-school-learning', [({'noun.cognition'}, ('discipline', 'subject-n', 'science-n', 'knowledge_domain',
                                                     'education', 'learning', 'study-n', 'skill', 'language-n')),
                               ({'noun.act'}, ('education', 'teaching', 'study-n', 'learning', 'examination', 'test-n')),
                               ({'noun.communication'}, ('textbook', 'book-n', 'lesson', 'exercise', 'question-n',
                                                         'answer-n', 'language-n', 'word-n', 'letter-n', 'grammar')),
                               ({'noun.person'}, ('student', 'pupil', 'scholar', 'educator', 'teacher')),
                               ({'verb.cognition'}, ('learn-v', 'study-v', 'teach-v'))]),
    ('topic-time', [({'noun.time'}, ())]),
    ('topic-money-shopping', [({'noun.possession'}, ()), ({'verb.possession'}, ()),
                              ({'noun.act'}, ('commerce', 'transaction', 'purchase', 'sale', 'shopping', 'payment')),
                              ({'noun.person'}, ('customer', 'merchant', 'seller', 'buyer'))]),
    ('topic-communication', [({'verb.communication'}, ()),
                             ({'noun.communication'}, ('message', 'statement', 'speech', 'conversation', 'news',
                                                       'letter-n', 'signal', 'telephone', 'mail', 'information',
                                                       'request', 'promise', 'argument', 'discussion', 'broadcast'))]),
    ('topic-technology', [({'noun.artifact'}, ('device', 'electronic_equipment', 'computer', 'machine', 'equipment',
                                               'electrical_device', 'apparatus', 'mechanism', 'instrument-n', 'system-n',
                                               'telephone', 'camera', 'battery', 'screen')),
                          ({'noun.communication'}, ('software', 'program-n', 'computer_code', 'web', 'internet', 'data-n',
                                                    'file-n', 'database'))]),
    ('topic-everyday-actions', [({'verb.motion'}, ()), ({'verb.contact'}, ()), ({'verb.perception'}, ()),
                                ({'verb.stative', 'verb.change', 'verb.creation', 'verb.social'}, ())]),
    ('topic-thinking-ideas', [({'verb.cognition'}, ()), ({'noun.cognition'}, ()), ({'noun.motive'}, ())]),
    ('topic-society-law', [({'noun.act'}, ('crime', 'wrongdoing', 'law-n', 'legal_action', 'war-n', 'military_action',
                                           'politics', 'governing', 'election', 'protest')),
                           ({'noun.group'}, ('government', 'political_unit', 'social_group', 'military_unit', 'party-n',
                                             'nation', 'people-n', 'community', 'society', 'polity')),
                           ({'noun.person'}, ('criminal', 'wrongdoer', 'lawyer', 'politician', 'soldier', 'ruler',
                                              'citizen', 'police', 'judge'))]),
    ('topic-numbers-measures', [({'noun.quantity'}, ()), ({'noun.shape'}, ()), ({'noun.relation'}, ())]),
    ('topic-describing', [({'adj.all', 'adj.pert'}, ())]),
    ('topic-connectors', [({'adv.all'}, ())]),
]

SENSITIVE = re.compile(r'\b(sex|sexual|sexy|naked|nude|porn|rape|drug|cocaine|heroin|kill|killed|killing|murder|suicide|'
                       r'gun|guns|shoot|shot|bomb|terror|drunk|beer|wine|vodka|whisky|cigarette|smoke|hell|damn|stupid|'
                       r'idiot|hate|bitch|fuck|shit|ass|gay|lesbian|racist|slave|nazi|hitler|god|jesus|allah|bible|church|'
                       r'pee|peed|poop|pray|religion|alcohol|kiss|kissed|bed with|girlfriend|boyfriend|die|died|dead|death|blood|weapon)\b',
                       re.I)


def lemma_forms():
    forms = set()
    for group in IRREGULAR.replace('\n', '').split('|'):
        ws = group.split()
        forms |= {w for w in ws[1:] if w != ws[0]}
    return forms


def main(aligned_path, draft_path):
    cards = json.loads(Path(aligned_path).read_text(encoding='utf-8'))['cards']
    words = {c['word'] for c in cards}
    irregular_forms = lemma_forms()
    draft, dropped = [], Counter()
    for c in cards:
        w, pos, wn = c['word'], c['pos'], c['wordnet']
        reason = None
        if pos in ('pronoun', 'idiom'):
            reason = 'function-word'
        elif w in irregular_forms or any(w.endswith(suf) and w[:-len(suf)] in words for suf in ('s', 'es', 'ed', 'ing', 'd')):
            reason = 'inflected-form'
        elif c['occurrences'] and c['capitalized'] / c['occurrences'] > 0.6 and not c['cefr']:
            reason = 'proper-noun'
        elif SENSITIVE.search(w) or SENSITIVE.search(c['examples'][0]['en']):
            reason = 'sensitive'
        elif len(w) < 2:
            reason = 'too-short'
        if reason:
            dropped[reason] += 1
            continue
        deck = None
        if pos in ('conjunction', 'preposition'):
            deck = 'topic-connectors'
        else:
            lexfile = wn['lexfile'] or ''
            chain = ' '.join(wn['hypernyms'])
            for slug, rules in RULES:
                for lexfiles, keys in rules:
                    if lexfile in lexfiles and (not keys or any(k in chain for k in keys)):
                        deck = slug
                        break
                if deck:
                    break
        draft.append({'word': w, 'deck': deck, 'pos': pos, 'lexfile': wn['lexfile'], 'term': c['term']})
    Path(draft_path).write_text(json.dumps(draft, ensure_ascii=False, indent=0), encoding='utf-8')
    print('dropped', dict(dropped))
    print('draft', Counter(d['deck'] for d in draft).most_common())


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
