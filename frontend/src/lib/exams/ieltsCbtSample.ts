/**
 * Self-authored IELTS-format sample exam (2026-11-13) for the CBT room preview, visual regression and functional tests.
 * Every passage, question and prompt here was written for English Coach; nothing is copied from a published test. It is
 * shaped exactly like the runtime attempt manifest (`PublicManifestDto`), so the room renders it with no special case.
 * It is NOT part of the exam bank and must never be imported as one (docs/ielts-exam/ADDING_NEW_EXAM.md).
 */
import type { PublicGroupDto, PublicItemDto, PublicManifestDto, PublicPartDto, PublicSectionDto } from '@/types/exams';

type Opt = { id: string; text: string };
const TFNG: Opt[] = [
  { id: 'TRUE', text: 'TRUE' },
  { id: 'FALSE', text: 'FALSE' },
  { id: 'NOT GIVEN', text: 'NOT GIVEN' },
];
const YNNG: Opt[] = [
  { id: 'YES', text: 'YES' },
  { id: 'NO', text: 'NO' },
  { id: 'NOT GIVEN', text: 'NOT GIVEN' },
];

let seq = 0;
function item(n: number, interactionType: string, prompt: string, options?: Opt[], extra: Record<string, unknown> = {}): PublicItemDto {
  seq += 1;
  return {
    id: `sample-item-${n}`,
    placementId: `sample-p-${n}`,
    prompt,
    interactionType,
    optionDefinitions: { questionNumber: n, ...(options ? { options } : {}), ...extra },
    cardinality: 1,
  };
}
function group(id: string, items: PublicItemDto[], presentation: PublicGroupDto['presentation'], stimuli: PublicGroupDto['stimuli'] = [], skill = 'READING'): PublicGroupDto {
  return { id, questionType: 'SAMPLE', skill, stimuli, items, presentation };
}
function part(code: string, ordinal: number, groups: PublicGroupDto[]): PublicPartDto {
  return { id: `sample-${code}`, partCode: code, ordinal, groups };
}
const text = (id: string, title: string, body: string) => ({ id, kind: 'TEXT', title, bodyPayload: { text: body }, assets: [] as any[] });
const audio = (id: string) => ({ id, kind: 'AUDIO', title: '', bodyPayload: {}, assets: [{ assetId: `${id}-asset`, role: 'PRIMARY', mimeType: 'audio/wav', delivery: 'PLAYBACK_GRANT' }] });
const figure = (id: string, alt: string) => ({ id, kind: 'IMAGE', title: '', bodyPayload: { altText: alt }, assets: [{ assetId: `${id}-asset`, role: 'FIGURE', mimeType: 'image/svg+xml', delivery: 'PLAYBACK_GRANT' }] });

// ─── Listening ──────────────────────────────────────────────────────────────────────────────────────────────────
const L1 = group(
  'sample-l1',
  Array.from({ length: 10 }, (_, i) => item(i + 1, 'TEXT_GAP', `Gap ${i + 1}`)),
  {
    questions: '1-10',
    instructions: ['Complete the notes. Write ONE WORD AND/OR A NUMBER for each answer.'],
    stem: [
      'Community garden membership',
      '',
      'Plot holders:',
      '- each plot measures (1) ______ metres long',
      '- annual fee: £(2) ______',
      '- tools are kept in the (3) ______ near the gate',
      '',
      'Rules:',
      '- water only before (4) ______ in summer',
      '- no (5) ______ fertiliser is allowed',
      '- bring your own (6) ______ for weeds',
      '',
      'Events:',
      '- seed swap on the first (7) ______ of each month',
      '- harvest supper in (8) ______',
      '- contact the secretary, Ms (9) ______',
      '- phone number: (10) ______',
    ].join('\n'),
    wordLimit: 1,
    wordLimitRule: 'ONE WORD AND/OR A NUMBER',
  },
  [audio('sample-audio-1')],
  'LISTENING'
);
const L2a = group(
  'sample-l2a',
  [
    item(11, 'SINGLE_CHOICE', 'The museum was first opened as', [
      { id: 'A', text: 'a railway station.' },
      { id: 'B', text: 'a wool warehouse.' },
      { id: 'C', text: 'a school for engineers.' },
    ]),
    item(12, 'SINGLE_CHOICE', 'Visitors on the guided tour must', [
      { id: 'A', text: 'book a day in advance.' },
      { id: 'B', text: 'wear the shoes provided.' },
      { id: 'C', text: 'leave large bags at the desk.' },
    ]),
    item(13, 'SINGLE_CHOICE', 'The most popular exhibit is', [
      { id: 'A', text: 'the steam pump.' },
      { id: 'B', text: 'the weaving room.' },
      { id: 'C', text: 'the map collection.' },
    ]),
    item(14, 'SINGLE_CHOICE', 'Photography is not allowed in', [
      { id: 'A', text: 'the archive.' },
      { id: 'B', text: 'the café.' },
      { id: 'C', text: 'the garden.' },
    ]),
    item(15, 'SINGLE_CHOICE', 'The speaker recommends ending the visit at', [
      { id: 'A', text: 'the roof terrace.' },
      { id: 'B', text: 'the gift shop.' },
      { id: 'C', text: 'the canal path.' },
    ]),
  ],
  { questions: '11-15', instructions: ['Choose the correct letter, A, B or C.'] },
  [audio('sample-audio-2')],
  'LISTENING'
);
const mapOptions: Opt[] = 'ABCDEFG'.split('').map((id) => ({ id, text: id }));
const L2b = group(
  'sample-l2b',
  [
    item(16, 'LABEL_ASSIGNMENT', 'Ticket office', mapOptions),
    item(17, 'LABEL_ASSIGNMENT', 'Cloakroom', mapOptions),
    item(18, 'LABEL_ASSIGNMENT', 'Children’s workshop', mapOptions),
    item(19, 'LABEL_ASSIGNMENT', 'Lift', mapOptions),
    item(20, 'LABEL_ASSIGNMENT', 'Lecture hall', mapOptions),
  ],
  { questions: '16-20', instructions: ['Label the plan below. Choose the correct letter, A–G.'] },
  [figure('sample-map', 'Plan of the museum ground floor with areas labelled A to G')],
  'LISTENING'
);
const two = (n1: number, n2: number, prompt: string, options: Opt[]) => [item(n1, 'SINGLE_CHOICE', prompt, options), item(n2, 'SINGLE_CHOICE', prompt, options)];
const L3a = group(
  'sample-l3a',
  [
    ...two(21, 22, 'Which TWO problems did the students have with their survey?', [
      { id: 'A', text: 'Too few people replied.' },
      { id: 'B', text: 'Some questions were unclear.' },
      { id: 'C', text: 'The deadline was too short.' },
      { id: 'D', text: 'The online form crashed.' },
      { id: 'E', text: 'Answers were hard to compare.' },
    ]),
    ...two(23, 24, 'Which TWO things will they change in the final report?', [
      { id: 'A', text: 'the title' },
      { id: 'B', text: 'the order of the sections' },
      { id: 'C', text: 'the charts' },
      { id: 'D', text: 'the list of sources' },
      { id: 'E', text: 'the summary' },
    ]),
  ],
  { questions: '21-24', instructions: ['Choose TWO letters, A–E.'], selection: { count: 2, questions: [21, 22] } },
  [audio('sample-audio-3')],
  'LISTENING'
);
const L3b = group('sample-l3b', [], { questions: '23-24', instructions: ['Choose TWO letters, A–E.'], selection: { count: 2, questions: [23, 24] } }, [], 'LISTENING');
L3b.items = L3a.items.splice(2, 2);
const L3c = group(
  'sample-l3c',
  [25, 26, 27, 28, 29, 30].map((n, i) =>
    item(n, 'SINGLE_CHOICE', ['The tutor thinks the introduction is', 'The interviews were most useful for', 'The students agree the budget section', 'Their main source of data was', 'The tutor suggests they reduce', 'They will present their work'][i], [
      { id: 'A', text: ['too long.', 'checking numbers.', 'needs more detail.', 'a council report.', 'the number of tables.', 'next Monday.'][i] },
      { id: 'B', text: ['well organised.', 'finding examples.', 'is already complete.', 'their own survey.', 'the length of quotations.', 'at the end of term.'][i] },
      { id: 'C', text: ['missing a clear aim.', 'choosing a topic.', 'should be removed.', 'a newspaper article.', 'the use of headings.', 'to a different group.'][i] },
    ])
  ),
  { questions: '25-30', instructions: ['Choose the correct letter, A, B or C.'] },
  [],
  'LISTENING'
);
const L4 = group(
  'sample-l4',
  Array.from({ length: 10 }, (_, i) => item(31 + i, 'TEXT_GAP', `Gap ${31 + i}`)),
  {
    questions: '31-40',
    instructions: ['Complete the notes. Write ONE WORD ONLY for each answer.'],
    stem: [
      'How cities cool down',
      '',
      'Causes of urban heat:',
      '- dark surfaces absorb (31) ______ during the day',
      '- buildings block the (32) ______ that would carry heat away',
      '- engines and air conditioners release (33) ______ heat',
      '',
      'Solutions:',
      '- painting roofs a light (34) ______',
      '- planting trees along (35) ______',
      '- creating small parks called pocket (36) ______',
      '- using (37) ______ to cool public squares',
      '',
      'Results:',
      '- night temperatures fell most in older (38) ______',
      '- residents reported better (39) ______',
      '- costs were lower than expected because of local (40) ______',
    ].join('\n'),
    wordLimit: 1,
    wordLimitRule: 'ONE WORD ONLY',
  },
  [audio('sample-audio-4')],
  'LISTENING'
);

const listening: PublicSectionDto = {
  id: 'sample-section-listening',
  skill: 'LISTENING',
  ordinal: 1,
  durationSeconds: 1800,
  parts: [
    part('LISTENING_PART_1', 1, [L1]),
    part('LISTENING_PART_2', 2, [L2a, L2b]),
    part('LISTENING_PART_3', 3, [L3a, L3b, L3c]),
    part('LISTENING_PART_4', 4, [L4]),
  ],
};

// ─── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────
const P1 = text(
  'sample-passage-1',
  'The quiet return of urban beekeeping',
  [
    'For most of the twentieth century, keeping bees was regarded as a rural pastime. Hives belonged to orchards and farmyards, and the idea of placing one on a city roof would have struck many people as both strange and slightly dangerous. Over the past two decades, however, that view has changed in many European and North American cities, where beekeeping associations report waiting lists for training courses.',
    'Part of the explanation lies in the city itself. Urban parks, railway embankments and private gardens contain a remarkable variety of flowering plants, and because they are planted for decoration rather than for a single crop, something is usually in bloom from early spring until late autumn. A hive in the countryside may face weeks with little forage once a field of rapeseed has finished flowering; a hive in a city often does not.',
    'Cities can also be warmer than the surrounding land by two or three degrees, which allows colonies to start foraging earlier in the year. Some researchers have found that urban colonies produce more honey per hive than rural ones, although they caution that the comparison depends heavily on the season and on how carefully the hives are managed.',
    'Not everyone welcomes the trend. Ecologists point out that honeybees are only one of hundreds of bee species, and that most wild bees live alone, nest in the ground and forage over much shorter distances. If too many hives are placed in a small area, honeybees may compete with these wild species for the same flowers. Several city councils now ask new beekeepers to register their hives so that the number per district can be monitored.',
    'Supporters respond that a well-run hive can be a powerful teaching tool. Schools that keep bees use them to explain pollination, food chains and even mathematics, as pupils count frames and calculate the weight of honey. The most experienced urban beekeepers agree on one point: the hive itself matters less than the planting around it, and a city that wants healthy bees of every kind must first provide enough flowers.',
  ].join('\n\n')
);
const P2 = text(
  'sample-passage-2',
  'Why ships learned to sail slower',
  [
    'A Throughout the history of shipping, speed has usually been treated as a virtue. Faster ships carried more voyages in a year, reached markets before their rivals and kept perishable cargo fresh. It is therefore surprising that, since the late 2000s, many of the largest cargo vessels have deliberately reduced their speed.',
    'B The practice, known as slow steaming, began as a response to fuel prices. The relationship between a ship’s speed and the fuel it burns is far from linear: reducing speed by a fifth can cut fuel consumption by around half. When oil became expensive, operators discovered that adding a few days to a long voyage saved more money than it cost.',
    'C The change brought unexpected technical problems. Engines designed to run at high power for weeks at a time did not always respond well to long periods at low load, and some manufacturers had to issue new guidance on maintenance. Propellers, too, had been shaped for higher speeds, and a number of companies replaced them with designs better suited to slower sailing.',
    'D Customers were not uniformly pleased. Retailers who relied on predictable delivery times had to hold more stock in warehouses to cover the longer journeys, and the cost of that stock partly offset the savings at sea. For goods whose value falls quickly, such as fashion items or electronics, some firms moved part of their trade to air or rail.',
    'E More recently, slow steaming has gained a second justification. Because burning less fuel also means releasing fewer greenhouse gases, regulators and environmental groups have begun to treat lower speeds as a climate measure. Some proposals would set speed limits on certain routes, an idea that shipping companies have met with caution, arguing that the right speed depends on the vessel, the cargo and the weather.',
    'F Whatever its future, slow steaming has shown that an industry long devoted to speed can adapt quickly when the economics change. It has also reminded planners that every link in a supply chain is connected: a decision taken in an engine room can change the size of a warehouse thousands of kilometres away.',
  ].join('\n\n')
);
const P3 = text(
  'sample-passage-3',
  'Measuring attention in the age of notifications',
  [
    'Few complaints are as common today as the claim that our attention spans are shrinking. It appears in newspaper columns, in conversations between teachers and in the advertising of apps that promise to help us concentrate. Yet the researchers who study attention are often more cautious than the headlines, partly because attention turns out to be surprisingly difficult to measure.',
    'One problem is that attention is not a single ability. Psychologists distinguish between sustained attention, the capacity to stay focused on one task over time, and selective attention, the ability to ignore distractions. A person may be good at one and poor at the other, and a test that measures one may say little about the other. Many popular claims about falling attention spans, the writer believes, mix these ideas together.',
    'Laboratory studies also face the problem of context. In an experiment, participants usually know they are being observed and are asked to complete tasks with no personal meaning. Outside the laboratory, people concentrate for long periods on things they care about: a difficult novel, a game of chess, a conversation with a friend. Measuring attention without measuring motivation, in this view, is like measuring a runner’s speed without asking whether they wanted to run.',
    'None of this means that digital devices have no effect. Studies that track people’s phone use show that frequent interruptions make work slower and increase mistakes, even when the interruption itself lasts only a few seconds. The cost appears to come not from the interruption but from the effort of returning to the original task, which can take several minutes for complex work.',
    'What, then, should individuals do? The most consistent advice from the research is modest. Turning off non-essential notifications, setting aside fixed periods for messages and keeping the phone out of sight during demanding work all appear to help. Such habits will not transform anyone’s abilities, but they reduce the number of times attention must be rebuilt, and that, the writer suggests, is where most of the damage is done.',
  ].join('\n\n')
);
const R1a = group(
  'sample-r1a',
  [
    item(1, 'TRUTH_CLASSIFICATION', 'Beekeeping courses in some cities are oversubscribed.', TFNG),
    item(2, 'TRUTH_CLASSIFICATION', 'City plants are mostly chosen to feed bees.', TFNG),
    item(3, 'TRUTH_CLASSIFICATION', 'Rural hives may run short of food after a crop has flowered.', TFNG),
    item(4, 'TRUTH_CLASSIFICATION', 'Urban colonies always produce more honey than rural ones.', TFNG),
    item(5, 'TRUTH_CLASSIFICATION', 'Most wild bee species live in large colonies.', TFNG),
    item(6, 'TRUTH_CLASSIFICATION', 'Some councils require beekeepers to pay a registration fee.', TFNG),
    item(7, 'TRUTH_CLASSIFICATION', 'Schools use bees to teach more than one subject.', TFNG),
  ],
  {
    questions: '1-7',
    instructions: ['Choose TRUE if the statement agrees with the information given in the text, choose FALSE if the statement contradicts the information, or choose NOT GIVEN if there is no information on this.'],
  },
  [P1]
);
const R1b = group(
  'sample-r1b',
  [
    item(8, 'TEXT_GAP', 'In cities, flowers are usually available from early spring until late ______.'),
    item(9, 'TEXT_GAP', 'Cities may be up to three ______ warmer than the countryside.'),
    item(10, 'TEXT_GAP', 'Ecologists warn that honeybees may ______ with wild bees for flowers.'),
    item(11, 'TEXT_GAP', 'Most wild bees nest in the ______.'),
    item(12, 'TEXT_GAP', 'Pupils count frames and work out the ______ of honey.'),
    item(13, 'TEXT_GAP', 'Experienced beekeepers believe the ______ around a hive matters most.'),
  ],
  { questions: '8-13', instructions: ['Complete the sentences. Write ONE WORD ONLY from the text for each answer.'], wordLimit: 1, wordLimitRule: 'ONE WORD ONLY' },
  [P1]
);
const headings: Opt[] = [
  { id: 'i', text: 'An early commercial motive' },
  { id: 'ii', text: 'Machines built for a different task' },
  { id: 'iii', text: 'A cost passed on to buyers' },
  { id: 'iv', text: 'The history of the first steamships' },
  { id: 'v', text: 'A new reason to keep speeds down' },
  { id: 'vi', text: 'How crews spend the extra days' },
  { id: 'vii', text: 'A wider lesson about connected systems' },
];
const R2a = group(
  'sample-r2a',
  [
    item(14, 'HEADING_MATCHING', 'Section B', headings),
    item(15, 'HEADING_MATCHING', 'Section C', headings),
    item(16, 'HEADING_MATCHING', 'Section D', headings),
    item(17, 'HEADING_MATCHING', 'Section E', headings),
    item(18, 'HEADING_MATCHING', 'Section F', headings),
  ],
  { questions: '14-18', instructions: ['The text has six sections, A–F. Choose the correct heading for sections B–F from the list of headings below.'] },
  [P2]
);
const groupsOfPeople: Opt[] = [
  { id: 'A', text: 'ship operators' },
  { id: 'B', text: 'engine manufacturers' },
  { id: 'C', text: 'retailers' },
  { id: 'D', text: 'regulators' },
];
const R2b = group(
  'sample-r2b',
  [
    item(19, 'MATCHING', 'issued new advice on looking after equipment', groupsOfPeople),
    item(20, 'MATCHING', 'needed to keep larger quantities of goods', groupsOfPeople),
    item(21, 'MATCHING', 'found that longer voyages could reduce costs', groupsOfPeople),
    item(22, 'MATCHING', 'have considered fixed limits on some routes', groupsOfPeople),
  ],
  { questions: '19-22', instructions: ['Match each statement with the correct group, A–D.', 'You may choose any letter more than once.'] },
  [P2]
);
const R2c = group(
  'sample-r2c',
  [
    ...two(23, 24, 'Which TWO effects of slow steaming does the writer mention?', [
      { id: 'A', text: 'some trade moved to other forms of transport' },
      { id: 'B', text: 'ports became more crowded' },
      { id: 'C', text: 'some ships were given new propellers' },
      { id: 'D', text: 'crews were reduced in size' },
      { id: 'E', text: 'insurance costs increased' },
    ]),
  ],
  { questions: '23-24', instructions: ['Choose TWO letters, A–E.'], selection: { count: 2, questions: [23, 24] } },
  [P2]
);
const R2d = group(
  'sample-r2d',
  [item(25, 'TEXT_GAP', 'Gap 25'), item(26, 'TEXT_GAP', 'Gap 26')],
  {
    questions: '25-26',
    instructions: ['Complete the summary. Write NO MORE THAN TWO WORDS from the text for each answer.'],
    stem: 'Lower speeds cut fuel use sharply because the link between speed and fuel is not (25) ______. Environmental groups now also see slow steaming as a (26) ______.',
    wordLimit: 2,
    wordLimitRule: 'NO MORE THAN TWO WORDS',
  },
  [P2]
);
const R3a = group(
  'sample-r3a',
  [
    item(27, 'TRUTH_CLASSIFICATION', 'Researchers generally share the certainty of newspaper columns.', YNNG),
    item(28, 'TRUTH_CLASSIFICATION', 'Popular claims often confuse different kinds of attention.', YNNG),
    item(29, 'TRUTH_CLASSIFICATION', 'Motivation should be considered when attention is measured.', YNNG),
    item(30, 'TRUTH_CLASSIFICATION', 'Phone interruptions have no measurable effect on work.', YNNG),
    item(31, 'TRUTH_CLASSIFICATION', 'Schools should ban phones during lessons.', YNNG),
  ],
  {
    questions: '27-31',
    instructions: ['Choose YES if the statement agrees with the claims of the writer, choose NO if the statement contradicts the claims of the writer, or choose NOT GIVEN if it is impossible to say what the writer thinks about this.'],
  },
  [P3]
);
const R3b = group(
  'sample-r3b',
  [
    item(32, 'SINGLE_CHOICE', 'According to the text, attention is hard to measure because', [
      { id: 'A', text: 'tests are too expensive to run.' },
      { id: 'B', text: 'it consists of more than one ability.' },
      { id: 'C', text: 'people refuse to take part in studies.' },
      { id: 'D', text: 'results change from year to year.' },
    ]),
    item(33, 'SINGLE_CHOICE', 'The comparison with a runner is used to show that', [
      { id: 'A', text: 'speed and attention are closely linked.' },
      { id: 'B', text: 'exercise improves concentration.' },
      { id: 'C', text: 'willingness affects performance.' },
      { id: 'D', text: 'laboratory tests are always unfair.' },
    ]),
    item(34, 'SINGLE_CHOICE', 'Studies of phone use suggest the main cost of an interruption is', [
      { id: 'A', text: 'the time spent reading the message.' },
      { id: 'B', text: 'the stress it causes.' },
      { id: 'C', text: 'getting back to the earlier task.' },
      { id: 'D', text: 'the loss of sleep.' },
    ]),
    item(35, 'SINGLE_CHOICE', 'The writer’s advice in the final paragraph is described as', [
      { id: 'A', text: 'ambitious.' },
      { id: 'B', text: 'modest.' },
      { id: 'C', text: 'untested.' },
      { id: 'D', text: 'expensive.' },
    ]),
  ],
  { questions: '32-35', instructions: ['Choose the correct letter, A, B, C or D.'] },
  [P3]
);
const endings: Opt[] = [
  { id: 'A', text: 'can take several minutes for complex work.' },
  { id: 'B', text: 'is the ability to ignore distractions.' },
  { id: 'C', text: 'is usually missing from laboratory tasks.' },
  { id: 'D', text: 'reduces how often attention must be rebuilt.' },
  { id: 'E', text: 'has been proved in every country.' },
  { id: 'F', text: 'makes work slower and less accurate.' },
];
const R3c = group(
  'sample-r3c',
  [
    item(36, 'MATCHING', 'Selective attention', endings),
    item(37, 'MATCHING', 'Personal meaning', endings),
    item(38, 'MATCHING', 'Frequent interruption', endings),
    item(39, 'MATCHING', 'Returning to a difficult task', endings),
    item(40, 'MATCHING', 'Keeping the phone out of sight', endings),
  ],
  { questions: '36-40', instructions: ['Complete each sentence with the correct ending, A–F.'] },
  [P3]
);
const reading: PublicSectionDto = {
  id: 'sample-section-reading',
  skill: 'READING',
  ordinal: 2,
  durationSeconds: 3600,
  parts: [
    part('READING_PASSAGE_1', 1, [R1a, R1b]),
    part('READING_PASSAGE_2', 2, [R2a, R2b, R2c, R2d]),
    part('READING_PASSAGE_3', 3, [R3a, R3b, R3c]),
  ],
};

// ─── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────
const W1 = group(
  'sample-w1',
  [
    item(1, 'WRITING_RESPONSE', 'The chart below shows the number of visitors to three city libraries in 2015 and 2025.\n\nSummarise the information by selecting and reporting the main features, and make comparisons where relevant.', undefined, {
      minimumWords: 150,
      recommendedMinutes: 20,
    }),
  ],
  null,
  [figure('sample-chart', 'Bar chart of yearly visitors to the North, Central and Harbour libraries in 2015 and 2025')],
  'WRITING'
);
W1.items[0].placementId = 'sample-w-task1';
const W2 = group(
  'sample-w2',
  [
    item(2, 'WRITING_RESPONSE', 'Some people believe that cities should spend more money on public parks than on new roads. Others think that better roads are more important for a modern city.\n\nDiscuss both these views and give your own opinion.\n\nGive reasons for your answer and include any relevant examples from your own knowledge or experience.', undefined, {
      minimumWords: 250,
      recommendedMinutes: 40,
    }),
  ],
  null,
  [],
  'WRITING'
);
W2.items[0].placementId = 'sample-w-task2';
const writing: PublicSectionDto = {
  id: 'sample-section-writing',
  skill: 'WRITING',
  ordinal: 3,
  durationSeconds: 3600,
  parts: [part('WRITING_TASK_1', 1, [W1]), part('WRITING_TASK_2', 2, [W2])],
};

export const IELTS_CBT_SAMPLE: PublicManifestDto = {
  formId: 'sample-form',
  title: 'English Coach sample — IELTS Academic (self-authored)',
  family: 'IELTS',
  variant: 'ACADEMIC',
  scope: 'FULL',
  mode: 'EXAM_SIMULATION',
  manifestHash: 'sample',
  sections: [listening, reading, writing],
};

void seq;
