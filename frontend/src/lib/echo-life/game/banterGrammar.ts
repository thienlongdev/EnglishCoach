/**
 * Echo Life Living World — Deterministic 4-Beat English Banter & Memory Greeting Engine.
 *
 * Pure local template grammar driven by Big-5 temperament (`warm_extrovert`, `analytical_dry`,
 * `shy_gentle`, `playful_bold`), mood, weather, season, time-of-day, zone, career/activity,
 * pairwise affinity, district reputation, and episodic memory.
 *
 * Hard invariants:
 * - Zero network or model calls (AGENTS.md Section 17), < 0.004 ms per beat transition.
 * - 100% English-only (only "Café" carries an accent), zero emojis, zero raw "&" in display copy.
 * - 2,000+ distinct grounded combinations with per-resident Uint16Array(8) non-repetition ring buffer.
 */

export type BanterTone = 'warm_extrovert' | 'analytical_dry' | 'shy_gentle' | 'playful_bold';

export type BanterMicroCue = 'chat' | 'laugh' | 'nod' | 'wave';

export interface BanterMemoryCue {
  kind: string;
  day: number;
  subject: string;
  valence: number;
  salience: number;
  zone?: string;
  src?: string;
}

export interface BanterBeatContext {
  /** 4-beat exchange turn index: 0 = opener, 1 = reaction, 2 = follow-up/hook, 3 = closer. */
  beat: 0 | 1 | 2 | 3;
  topic: string;
  speakerId: string;
  speakerName: string;
  partnerId: string;
  partnerName: string;
  tone: BanterTone;
  mood: string;
  zone: string;
  weatherId: string;
  rainIntensity: number;
  snowIntensity: number;
  season: 0 | 1 | 2 | 3;
  phase: 'morning' | 'afternoon' | 'evening' | 'night';
  affinity: number;
  currentDay: number;
  seed: number;
  /** Optional current activity or career shift tag. */
  activity?: string;
  /** Optional episodic memory grounding Beat 0 or Beat 2 in real player deeds or gossip. */
  memory?: BanterMemoryCue | null;
  /** Optional witness display name when `memory.src` is set. */
  witnessName?: string;
  /** Optional local district reputation score (0..100). */
  districtRep?: number;
  /** Optional per-resident Uint16Array(8) non-repetition ring buffer (mutated in place). */
  recentIds?: Uint16Array;
}

export interface BanterBeatResult {
  text: string;
  templateId: number;
  beat: 0 | 1 | 2 | 3;
  topic: string;
  tone: BanterTone;
  microCue: BanterMicroCue;
}

export interface MemoryGreetingContext {
  residentId: string;
  residentName: string;
  tone: BanterTone;
  mood: string;
  zone: string;
  weatherId: string;
  rainIntensity: number;
  snowIntensity: number;
  rainTolerance: number;
  phase: 'morning' | 'afternoon' | 'evening' | 'night';
  friendship: number;
  isRival: boolean;
  currentDay: number;
  seed: number;
  memory?: BanterMemoryCue | null;
  witnessName?: string;
  vehicle?: { kind: 'car' | 'motorbike' | 'bike'; name: string; speed: number } | null;
  districtRep?: { score: number; tier: string } | null;
}

const ZONE_LABELS: Readonly<Record<string, string>> = {
  study: 'the study room',
  hall: 'the hallway',
  living: 'the living room',
  kitchen: 'the kitchen',
  bedroom: 'upstairs',
  bath: 'the washroom',
  yard: 'the home garden',
  gaming_room: 'the tech studio',
  balcony: 'the terrace balcony',
  garage: 'the garage',
  street: 'Riverside Lane',
  linh: 'Linh’s place',
  minh: 'Minh’s place',
  cafe: 'Pixel Café',
  bistro: 'Willow Corner Bistro',
  market: 'Sunrise Market',
  electronics_shop: 'Volt and Silicon',
  furniture_shop: 'Riverside Living',
  clothing_shop: 'Thread and Campus Apparel',
  vehicle_dealer: 'Greenway Motors',
  home_center: 'Timber and Stone Homeworks',
  repair_shop: 'Tech and Fix Workshop',
  campus: 'University Green',
  library: 'University Library',
  park: 'Riverside Park',
  fair: 'Boardwalk Fair',
  greenway: 'Riverside Greenway',
  atelier: 'Riverside Atelier',
  botanical: 'the Botanical Garden',
  lantern_garden: 'the Lantern Tea Garden',
  fountain_plaza: 'Fountain Court',
};

const SEASON_LABELS: readonly string[] = ['spring', 'summer', 'autumn', 'winter'];

const PHASE_TIME_PHRASE: Readonly<Record<BanterBeatContext['phase'], readonly string[]>> = {
  morning: ['this morning', 'before the midday rush', 'while the street is still waking up'],
  afternoon: ['this afternoon', 'between classes', 'before the late shift starts'],
  evening: ['this evening', 'once the lanterns switch on', 'as the courtyard cools down'],
  night: ['tonight', 'this late', 'before everything closes up'],
};

const SEASON_FLAVOR: readonly (readonly string[])[] = [
  ['spring blossoms', 'fresh breeze', 'mild air'],
  ['warm sunlight', 'long afternoons', 'river breeze'],
  ['crisp autumn air', 'golden leaves', 'soft twilight'],
  ['chilly winter air', 'frosty pavement', 'steaming mugs'],
];

const ACTIVITY_TOPIC_MAP: Readonly<Record<string, string>> = {
  barista: 'coffee',
  coffee: 'coffee',
  cook: 'coffee',
  cashier: 'campus',
  librarian: 'books',
  read: 'books',
  study: 'books',
  tutor: 'campus',
  repair: 'tech',
  gardener: 'garden',
  busker: 'music',
  basketball: 'sports',
  exercise_squat: 'sports',
  stretch: 'sports',
};

const ACTIVITY_DETAILS: Readonly<Record<string, readonly string[]>> = {
  barista: ['pulling espresso shots before the noon line forms', 'foaming steamed milk without a spill'],
  cashier: ['keeping the checkout queue moving with a smile', 'restocking the fresh snack shelves'],
  librarian: ['shelving return carts without breaking the quiet', 'spotting rare campus folios in the returns'],
  tutor: ['breaking tough speaking prompts into easy steps', 'helping first-years nail their practice notes'],
  repair: ['truing a bent wheel rim cleanly by ear', 'tightening commuter brakes before evening traffic'],
  gardener: ['trimming rosemary and jasmine while the soil is cool', 'keeping the courtyard planters bright'],
  busker: ['warming up acoustic chords near the fountain', 'drawing a happy evening crowd around the plaza'],
};

const TOPIC_NEXT_VENUES: Readonly<Record<string, readonly string[]>> = {
  rain: ['Willow Corner Bistro', 'Pixel Café', 'University Library', 'the covered arcade'],
  snow: ['Willow Corner Bistro', 'the Lantern Tea Garden', 'University Library', 'Sunrise Market'],
  coffee: ['Willow Corner Bistro', 'the corner booth', 'Sunrise Market', 'Fountain Court'],
  tech: ['Pixel Café', 'Volt and Silicon', 'Tech and Fix Workshop', 'University Green'],
  art: ['Riverside Atelier', 'the Botanical Garden', 'Riverside Living', 'Fountain Court'],
  music: ['Fountain Court', 'Riverside Atelier', 'Boardwalk Fair', 'Willow Corner Bistro'],
  sports: ['Riverside Park', 'Riverside Greenway', 'the half-court', 'Boardwalk Fair'],
  books: ['University Library', 'the upper stacks', 'Willow Corner Bistro', 'the Lantern Tea Garden'],
  garden: ['the Botanical Garden', 'the Lantern Tea Garden', 'Sunrise Market', 'Riverside Greenway'],
  campus: ['University Green', 'Fountain Court', 'University Library', 'Willow Corner Bistro'],
  evening: ['Riverside Lane', 'the Lantern Tea Garden', 'Fountain Court', 'Boardwalk Fair'],
  general: ['Willow Corner Bistro', 'Riverside Park', 'Fountain Court', 'Sunrise Market'],
};

const TOPIC_DETAILS: Readonly<Record<string, readonly string[]>> = {
  rain: [
    'rain shimmering across the lanterns',
    'dry awning space along the shops',
    'the sound of rain tapping on the eaves',
    'puddles pooling near the curb',
  ],
  snow: [
    'fresh snow settling along Riverside Lane',
    'keeping steady footing at the crossings',
    'hot tea after walking through the chill',
    'frost catching the lantern light',
  ],
  coffee: [
    'fresh matcha crepe batter from the griddle',
    'warm jasmine tea in the window booth',
    'a second espresso before the rush hits',
    'the cinnamon roast aroma drifting outside',
  ],
  tech: [
    'that 120 BPM chart on cabinet two',
    'quiet airflow beating noisy RGB fans',
    'hand-wired custom builds holding steady frames',
    'calibrating audio timing before the lobby opens',
  ],
  art: [
    'golden hour hitting the rooftops differently',
    'warm cedar tones paired with soft watercolor',
    'sketching candid moments between classes',
    'new gallery prints drying on the studio rack',
  ],
  music: [
    'that acoustic chord progression by the fountain',
    'packing spare guitar picks for twilight sets',
    'how cleanly an acoustic melody carries outside',
    'rehearsing harmonies before open-mic night',
  ],
  sports: [
    'the morning tailwind along the Greenway',
    'five minutes of shootaround clearing your head',
    'keeping a steady cadence up the river path',
    'running full-court drills next pickup game',
  ],
  books: [
    'the 1984 campus archive hiding fresh clues',
    'quiet reading stacks beating noisy group chats',
    'those autumn essays on the upper shelf',
    'old yearbooks mapping half the neighborhood',
  ],
  garden: [
    'moon-jasmine buds getting ready to bloom',
    'fresh rosemary catching the afternoon sun',
    'green pockets keeping the whole campus breathing',
    'herb clippings heading over to Sunrise Market',
  ],
  campus: [
    'how lively University Green feels every week',
    'everyone pitching in on the festival booths',
    'newcomers turning into familiar faces so fast',
    'keeping the plaza welcoming for first-years',
  ],
  evening: [
    'how Riverside Lane transforms once the lanterns glow',
    'evening breezes beating the eight o’clock rush',
    'taking one last unhurried stroll before heading in',
    'the warm shop windows lighting up the sidewalk',
  ],
  general: [
    'how the semester keeps picking up pace',
    'slowing down enough to notice the neighborhood',
    'catching up before the next busy stretch',
    'how every corner of Riverside has its own rhythm',
  ],
};

// Beat 0: Contextual Openers by Tone (4 tones x 6 templates = 24 base frames x topics x details x phases)
const BEAT0_BY_TONE: Readonly<Record<BanterTone, readonly string[]>> = {
  warm_extrovert: [
    'Honestly, {detail} around {zone} makes {time} feel so welcoming, {partner}.',
    'Have you noticed {detail} over by {zone}? Best part of {season} so far.',
    'So glad I bumped into you at {zone}, {partner} — I was just admiring {detail}.',
    'You can really feel the {seasonFlavor} around {zone} {time}, especially with {detail}.',
    'Every time I pass {zone} {time}, {detail} puts me right in a good mood.',
    'Between you and me, {partner}, {detail} at {zone} is worth slowing down for.',
  ],
  analytical_dry: [
    'Observe {zone} {time}: {detail} is the one variable nobody accounts for.',
    'Statistically speaking, {partner}, {detail} makes {zone} the smartest stop {time}.',
    'Quiet observation from {zone}: {detail} has been unusually consistent this {season}.',
    'If you are timing the crowd at {zone}, {detail} tells you everything you need to know.',
    'I checked the schedule twice, {partner}, and {detail} around {zone} still stands out.',
    'Not bad for {time} — {detail} actually justifies detouring through {zone}.',
  ],
  shy_gentle: [
    'I really like {detail} here at {zone}... it feels calmer {time}.',
    'Did you catch {detail} earlier, {partner}? It suits this {seasonFlavor} nicely.',
    'Being near {zone} {time} is easier when you notice small things like {detail}.',
    'Sorry to interrupt your thoughts, {partner}, I just loved {detail} around {zone}.',
    'Somehow {detail} makes {zone} feel a little quieter, even when folks walk past.',
    'I almost missed {detail} on my way to {zone} — glad I looked up {time}.',
  ],
  playful_bold: [
    'Tell me {detail} at {zone} does not beat sitting indoors {time}, {partner}!',
    'Bet you five credits you noticed {detail} the second you hit {zone}.',
    'Classic {season} energy around {zone} — {detail} is stealing the spotlight {time}.',
    'Alright {partner}, quick verdict on {zone} {time}: {detail} is an instant win.',
    'No way I am rushing past {zone} when {detail} is right here {time}.',
    'Look around {zone}, {partner} — {detail} practically calls for an impromptu hangout.',
  ],
};

const TOPIC_HOOKS: Readonly<Record<string, readonly string[]>> = {
  rain: ['drying off over hot tea', 'watching the rain from the window', 'sharing a dry booth'],
  snow: ['warming up with ginger tea', 'comparing winter routes', 'thawing out by the heater'],
  coffee: ['splitting a matcha crepe', 'sampling the afternoon roast', 'grabbing the sunny booth'],
  tech: ['testing that rhythm chart', 'checking out a custom build', 'swapping setup tips'],
  art: ['checking the fresh watercolors', 'comparing sketchbook layouts', 'catching the golden light'],
  music: ['trying a new acoustic riff', 'tuning up before the twilight set', 'picking evening songs'],
  sports: ['running a quick shootaround', 'stretching out by the river path', 'planning the next match'],
  books: ['browsing the 1984 archive shelf', 'trading quiet study notes', 'comparing essay drafts'],
  garden: ['checking the jasmine blooms', 'smelling the fresh rosemary beds', 'walking the garden trail'],
  campus: ['checking the festival sign-ups', 'meeting new club leads', 'planning the weekend booth'],
  evening: ['strolling under the lanterns', 'catching the evening breeze', 'winding down along the lane'],
  general: ['catching up properly', 'taking a real five-minute break', 'swapping neighborhood news'],
};

const MOOD_TAG: Readonly<Record<string, string>> = {
  cheerful: 'bright mood',
  focused: 'steady focus',
  relaxed: 'easy pace',
  tired: 'quiet breather',
  curious: 'fresh curiosity',
  sheltering: 'dry refuge',
  excited: 'high energy',
};

// Beat 1: Personality-modulated Reactions by Tone x Affinity Band (high / mid / guarded)
const BEAT1_HIGH: Readonly<Record<BanterTone, readonly string[]>> = {
  warm_extrovert: [
    'Classic {partner} — you always notice {detail} before anyone else around {zone}.',
    'I knew you would say that, {partner}! You bring such {moodTag} to {zone} {time}.',
    'That is why I love bumping into you at {zone} {time} — always up for {hook}.',
    'Right? Let us enjoy this {seasonFlavor} at {zone} before {hook} calls us away.',
    'Honestly, {partner}, sharing a laugh over {detail} makes {season} fly by.',
    'You read my mind, {partner} — {zone} feels twice as warm with you around {time}.',
  ],
  analytical_dry: [
    'Fair point, {partner}. Even I cannot fault your read on {detail} at {zone}.',
    'Sharp eye, {partner} — I clocked the exact same shift around {zone} {time}.',
    'Agreed. Good timing for {hook} too, since {zone} fills up fast during {season}.',
    'Credit where it is due, {partner}: your take on {detail} holds up nicely {time}.',
    'Solid observation. This {seasonFlavor} pairs surprisingly well with a {moodTag}.',
    'Accurate call, {partner} — hard to beat {zone} when {detail} lines up like this.',
  ],
  shy_gentle: [
    'You always put it into words so warmly, {partner} — I noticed {detail} too.',
    'It is nicer pausing at {zone} {time} with someone who appreciates {seasonFlavor}.',
    'Haha, you caught me smiling, {partner} — {hook} sounds wonderful {time}.',
    'Thank you for noticing that at {zone}, {partner}. It brings such a {moodTag}.',
    'I almost kept that thought to myself, {partner}, yet {detail} really suits {season}.',
    'Being here at {zone} {time} feels much easier once we start chatting, {partner}.',
  ],
  playful_bold: [
    'Ha! Took the words straight out of my mouth, {partner} — {detail} wins {time}!',
    'Now you are talking, {partner}! No wonder {zone} pulls us in every {season}.',
    'Bold call, {partner}, and I am backing {hook} a hundred percent {time}.',
    'That is the spirit! Nobody reads the {seasonFlavor} around {zone} faster than you.',
    'Look at that {moodTag}, {partner} — {detail} practically demands an encore.',
    'Spot on, {partner}! Beats rushing past {zone} without stopping for {hook}.',
  ],
};

const BEAT1_MID: Readonly<Record<BanterTone, readonly string[]>> = {
  warm_extrovert: [
    'That is a lovely way to look at {detail} around {zone}, {partner}.',
    'True enough! Everything feels friendlier at {zone} {time}, especially with {seasonFlavor}.',
    'I had not thought of {detail} like that, {partner}, and now I cannot unsee it.',
    'Makes sense — {zone} shows its best side during {season} when folks stop for {hook}.',
  ],
  analytical_dry: [
    'Reasonable take, {partner}. The pacing around {zone} does improve {time}.',
    'I can see that. Most people walk straight past {detail} at {zone} without noticing.',
    'Accurate enough. This {seasonFlavor} certainly changes how folks handle {hook}.',
    'Worth noting, {partner} — I will keep an eye on {detail} next time I pass {zone}.',
  ],
  shy_gentle: [
    'Mm, yes... I think {zone} has a gentle rhythm {time} with this {seasonFlavor}.',
    'That makes a lot of sense, {partner} — {detail} really stood out to me too.',
    'Oh, I see what you mean now. Stopping for {hook} feels nicer {time}.',
    'You have a good eye for quiet details around {zone}, {partner}.',
  ],
  playful_bold: [
    'Not a bad call at all, {partner} — {detail} brings real energy to {zone} {time}.',
    'I can get behind {hook}! Beats staring at a blank schedule all {season}.',
    'Look at you keeping tabs on {zone}, {partner}. Solid pick for {time}.',
    'Alright, I will give you that one — this {seasonFlavor} hits different out here.',
  ],
};

const BEAT1_GUARDED: Readonly<Record<BanterTone, readonly string[]>> = {
  warm_extrovert: [
    'Fair enough, {partner} — we may disagree on plans, yet {zone} still brings people together {time}.',
    'I hear you, {partner}. Let us keep a {moodTag} around {zone} while we sort out {hook}.',
    'Even on busy {season} weeks, {partner}, noticing {detail} helps everyone breathe.',
    'Point taken, {partner}. At least we can both appreciate how {zone} runs {time}.',
  ],
  analytical_dry: [
    'Ambitious optimism as usual, {partner}. Just make sure the schedule around {zone} still balances.',
    'Duly noted, {partner}. Keep the receipts as tidy as your pitch on {detail}.',
    'A pleasant theory for {time}, {partner}, provided nobody forgets the real constraints.',
    'Perhaps. Though {zone} stays smooth this {season} because someone checks every detail twice.',
  ],
  shy_gentle: [
    'I... suppose we see {detail} at {zone} from different angles, {partner}.',
    'Maybe so, {partner}. I just hope everyone gets quiet room around {zone} {time}.',
    'That is one way to read it, {partner}. Let us keep things peaceful this {season}.',
    'I hear your point, {partner}... I still prefer taking {hook} one careful step at a time.',
  ],
  playful_bold: [
    'Easy there, {partner} — save the victory speech until {hook} actually lands {time}.',
    'Big talk around {zone} for {time}, {partner}, though I respect the confidence.',
    'Careful, {partner}, keep pushing that line on {detail} and I might make it a wager.',
    'We will see how that holds up across {zone} by the end of {season}, {partner}.',
  ],
};

// Beat 2: Follow-up / Plan Hook / Local Buzz by Tone
const BEAT2_BY_TONE: Readonly<Record<BanterTone, readonly string[]>> = {
  warm_extrovert: [
    'If you have ten spare minutes {time}, we should swing by {nextVenue} for {hook}.',
    'Half the neighborhood seems headed toward {nextVenue} {time} — want to enjoy this {seasonFlavor} along the way?',
    'By the way, {partner}, save me a spot at {nextVenue} if you head over for {hook} before I do.',
    'We ought to bring a few neighbors from {zone} over to {nextVenue} once the rush settles.',
    'Nothing complements {detail} like a relaxed stop at {nextVenue} this {season}.',
    'With this {moodTag}, {partner}, turning {time} into a {nextVenue} hangout feels effortless.',
  ],
  analytical_dry: [
    'If foot traffic stays light {time}, heading to {nextVenue} for {hook} is the optimal move.',
    'I have a brief stop near {nextVenue} next; walk over from {zone} if our timing aligns.',
    'My notes say {nextVenue} is quietest {time} — ideal for {hook} without distractions.',
    'Assuming this {season} weather holds, {nextVenue} offers the cleanest reset after {zone}.',
    'Logically speaking, {partner}, pairing {detail} with a quick visit to {nextVenue} maximizes {time}.',
    'With a {moodTag} like this, {nextVenue} should give us twenty solid minutes for {hook}.',
  ],
  shy_gentle: [
    'I was thinking of slipping over to {nextVenue} for {hook} {time}, if you want quiet company.',
    'No pressure at all, {partner}, though {nextVenue} feels especially cozy with this {seasonFlavor}.',
    'If {nextVenue} is not too crowded {time}, a quiet corner after leaving {zone} sounds lovely.',
    'Maybe I will bring my notes over to {nextVenue} this {season} once things calm down.',
    'It is funny how {detail} always makes me crave a slow walk toward {nextVenue}.',
    'Having a gentle {moodTag} makes {hook} at {nextVenue} sound just right {time}.',
  ],
  playful_bold: [
    'Race you from {zone} to {nextVenue} {time}, {partner} — loser treats for {hook}!',
    'Say the word and we turn {time} into an impromptu {nextVenue} detour for {hook}.',
    'Next stop has to be {nextVenue}, {partner} — no excuses this {season}!',
    'Calling it now: {nextVenue} is going to be the liveliest corner around {zone} {time}.',
    'After seeing {detail}, skipping {nextVenue} with this {seasonFlavor} should be illegal!',
    'Keep that {moodTag} rolling, {partner} — {nextVenue} is waiting for us {time}!',
  ],
};

// Beat 3: Natural Closer + Micro-Action Cue
const BEAT3_BY_TONE: Readonly<Record<BanterTone, readonly { text: string; cue: BanterMicroCue }[]>> = {
  warm_extrovert: [
    { text: 'Deal! Take care around {zone}, {partner}, and wave if you spot me at {nextVenue}.', cue: 'wave' },
    { text: 'Count me in for {hook}, {partner} — always brighter catching up {time}.', cue: 'laugh' },
    { text: 'Sounds like a plan! Enjoy the {seasonFlavor} for the rest of {time}.', cue: 'nod' },
    { text: 'Love it. Catch you over at {nextVenue} once {zone} quiets down, {partner}!', cue: 'wave' },
    { text: 'Best chat of this {season}, {partner} — save that {moodTag} for {nextVenue}!', cue: 'laugh' },
    { text: 'Wonderful! Let us meet by {nextVenue} {time} and keep the streak going.', cue: 'nod' },
  ],
  analytical_dry: [
    { text: 'Agreed. Stay sharp around {zone}, {partner} — see you at {nextVenue}.', cue: 'nod' },
    { text: 'Solid plan for {time}. I will finish my checklist and meet you for {hook}.', cue: 'nod' },
    { text: 'Good briefing, {partner}. Do not forget an actual break this {season}.', cue: 'chat' },
    { text: 'Fair enough. Keep that {moodTag} steady and I will catch you near {nextVenue}.', cue: 'wave' },
    { text: 'Efficiently settled, {partner}. Enjoy the {seasonFlavor} on the walk over.', cue: 'nod' },
    { text: 'Noted for {time} — {nextVenue} beats standing around {zone} indefinitely.', cue: 'chat' },
  ],
  shy_gentle: [
    { text: 'Okay... I would really like {hook} at {nextVenue}, {partner}. See you shortly.', cue: 'nod' },
    { text: 'Thanks for pausing with me at {zone}, {partner}. Have a gentle rest of {time}.', cue: 'wave' },
    { text: 'I will look forward to {nextVenue} this {season}. Take care walking through the {seasonFlavor}.', cue: 'nod' },
    { text: 'That lifted my whole {time}, {partner} — glad we kept a calm {moodTag}.', cue: 'laugh' },
    { text: 'See you by {nextVenue} soon, {partner}... thanks for making {zone} feel warm.', cue: 'wave' },
    { text: 'Sounds really nice for {time}, {partner}. I will wave when I spot you.', cue: 'nod' },
  ],
  playful_bold: [
    { text: 'You are on for {hook}, {partner}! Try to keep up on the walk to {nextVenue}!', cue: 'laugh' },
    { text: 'Locked in! Catch you at {nextVenue} {time} before the best spot vanishes.', cue: 'wave' },
    { text: 'Now that is a proper {season} plan — go crush the rest of {time}, {partner}!', cue: 'laugh' },
    { text: 'Easy win around {zone}. Catch you on the next lap by {nextVenue}, {partner}!', cue: 'wave' },
    { text: 'Keep that {moodTag} blazing through this {seasonFlavor}, {partner} — see you soon!', cue: 'laugh' },
    { text: 'All set for {hook}! Do not make me start without you at {nextVenue}, {partner}.', cue: 'wave' },
  ],
};

// Weather-reactive overrides for Beat 0 when rain or snow is active
const WEATHER_BEAT0: Readonly<Record<'heavy_rain' | 'light_rain' | 'snow', Readonly<Record<BanterTone, readonly string[]>>>> = {
  heavy_rain: {
    warm_extrovert: [
      'What a sudden downpour near {zone}! Good thing {nextVenue} still has dry tables.',
      'This storm rolled in fast, {partner} — let us shake off the rain and stay warm!',
    ],
    analytical_dry: [
      'Heavy precipitation over {zone}: relocating indoors to {nextVenue} is the only sensible call.',
      'Rain gauge must be maxed out {time}, {partner}. Staying dry under cover wins.',
    ],
    shy_gentle: [
      'The storm sounds so loud over {zone}... I am glad we found dry shelter, {partner}.',
      'Heavy rain always makes {nextVenue} feel twice as cozy once you step inside.',
    ],
    playful_bold: [
      'Now that is a real cloudburst at {zone}! Hope you sprinted faster than I did, {partner}!',
      'Downpour like this practically mandates hot drinks at {nextVenue}, right {partner}?',
    ],
  },
  light_rain: {
    warm_extrovert: [
      'Light drizzle over {zone} makes the pavement glow — warm tea sounds amazing {time}.',
      'Not bad weather for a brisk umbrella walk past {zone}, eh {partner}?',
    ],
    analytical_dry: [
      'Mild drizzle around {zone}: umbrella deployed, schedule intact, minimal disruption.',
      'Light rain cuts the foot traffic nicely at {zone}, {partner}.',
    ],
    shy_gentle: [
      'I actually love soft rain like this at {zone}... everything smells fresh.',
      'The gentle drizzle makes {zone} feel like a painting {time}, {partner}.',
    ],
    playful_bold: [
      'Just enough drizzle at {zone} to keep folks moving briskly, {partner}!',
      'Light rain never stopped Riverside — grab a hot cup at {nextVenue} and keep rolling!',
    ],
  },
  snow: {
    warm_extrovert: [
      'Snow drifting down over {zone} never gets old — keep those hands warm, {partner}!',
      'Crisp snow around {zone} calls for something steaming hot from {nextVenue}.',
    ],
    analytical_dry: [
      'Winter snowfall along {zone}: watch your footing near the crossings, {partner}.',
      'Snowfall slows the lane down just enough to appreciate {zone} properly.',
    ],
    shy_gentle: [
      'Look how quietly the snow settles across {zone}... it softens every sound.',
      'Chilly out here by {zone}, {partner}, though the winter glow is worth it.',
    ],
    playful_bold: [
      'Snow day vibes hitting {zone} hard! Warm drinks at {nextVenue} are calling our names.',
      'Crisp winter air at {zone} wakes you up faster than espresso, {partner}!',
    ],
  },
};

function hashInt(str: string, seed: number): number {
  let h = (2166136261 ^ (seed | 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

function cleanDisplayText(raw: string): string {
  return raw.replace(/\s*&\s*/g, ' and ').replace(/\s{2,}/g, ' ').trim();
}

export function zoneDisplayName(zone: string | undefined | null): string {
  if (!zone) return 'Riverside Lane';
  const mapped = ZONE_LABELS[zone];
  if (mapped) return mapped;
  return cleanDisplayText(zone.replace(/_/g, ' '));
}

function humanizeSubject(subject: string, kind: string): string {
  const s = cleanDisplayText(subject || '');
  if (!s) {
    if (kind === 'player_gift') return 'thoughtful gift';
    if (kind === 'player_basketball') return 'clutch basket';
    if (kind === 'player_shared_activity') return 'shift together';
    return 'moment';
  }
  const low = s.toLowerCase();
  const streakMatch = /^streak_(\d+)$/.exec(low);
  if (streakMatch) return `${streakMatch[1]}-shot streak`;
  if (low.includes('busker')) return 'courtyard acoustic set';
  if (low.includes('barista')) return 'barista rush shift';
  if (low.includes('cashier') || low.includes('market')) return 'market checkout shift';
  if (low.includes('librar')) return 'library archive shift';
  if (low.includes('tutor')) return 'campus tutoring shift';
  if (low.includes('repair')) return 'workshop repair shift';
  if (low.includes('garden')) return 'botanical garden shift';
  if (low.startsWith('gifted ')) return s.slice(7);
  return cleanDisplayText(s.replace(/[_:]+/g, ' '));
}

function relativeDayPhrase(ageDays: number): string {
  if (ageDays <= 0) return 'earlier today';
  if (ageDays === 1) return 'yesterday';
  if (ageDays === 2) return 'two days ago';
  if (ageDays <= 5) return 'a few days ago';
  return 'last week';
}

function fillTemplate(tpl: string, vars: Readonly<Record<string, string>>): string {
  return cleanDisplayText(
    tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => vars[key] ?? ''),
  );
}

function pickNonRepeatingIndex(
  count: number,
  baseId: number,
  seedHash: number,
  recentIds?: Uint16Array,
): { idx: number; templateId: number } {
  if (count <= 1) {
    const id = Math.max(1, (baseId % 65000) + 1);
    recordRing(recentIds, id);
    return { idx: 0, templateId: id };
  }
  const start = seedHash % count;
  for (let step = 0; step < count; step++) {
    const idx = (start + step) % count;
    const id = ((baseId + idx) % 65000) + 1;
    if (!inRing(recentIds, id)) {
      recordRing(recentIds, id);
      return { idx, templateId: id };
    }
  }
  const id = ((baseId + start) % 65000) + 1;
  recordRing(recentIds, id);
  return { idx: start, templateId: id };
}

function inRing(buf: Uint16Array | undefined, id: number): boolean {
  if (!buf) return false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === id) return true;
  }
  return false;
}

function recordRing(buf: Uint16Array | undefined, id: number): void {
  if (!buf || buf.length === 0) return;
  for (let i = 0; i < buf.length - 1; i++) {
    buf[i] = buf[i + 1];
  }
  buf[buf.length - 1] = id & 0xffff;
}

/** Map normalized Big-5 traits ([0..1]) deterministically to one of the 4 banter temperaments. */
export function resolveBanterTone(traits: {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  calmness: number;
}): BanterTone {
  if (traits.extraversion < 0.52) {
    return traits.agreeableness >= 0.78 && traits.openness >= 0.80 ? 'shy_gentle' : 'analytical_dry';
  }
  if (traits.extraversion >= 0.72 && (traits.agreeableness < 0.86 || traits.conscientiousness <= 0.74)) {
    return 'playful_bold';
  }
  if (traits.conscientiousness >= 0.82 && traits.extraversion <= 0.70) {
    return 'analytical_dry';
  }
  return 'warm_extrovert';
}

/**
 * Format an episodic memory (first-hand or second-hand gossip) into a concrete English recollection.
 * References the actual item/activity, venue/zone, relative day phrase, and gossip witness when present.
 */
export function formatMemoryRecollection(
  mem: BanterMemoryCue,
  currentDay: number,
  speakerTone: BanterTone = 'warm_extrovert',
  witnessName?: string,
): string {
  const age = Math.max(0, Math.floor(currentDay - mem.day));
  const dayPhrase = relativeDayPhrase(age);
  const place = zoneDisplayName(mem.zone);
  const detail = humanizeSubject(mem.subject, mem.kind);

  // Second-hand gossip memory propagated between friends
  if (mem.src) {
    const who = cleanDisplayText(witnessName || mem.src);
    if (mem.kind === 'player_gift') {
      return `${who} told me about that ${detail} you brought over to ${place} ${dayPhrase} — everyone noticed!`;
    }
    if (mem.kind === 'player_basketball') {
      return `${who} was still talking about your ${detail} over at ${place} ${dayPhrase}. Word travels fast on Riverside Lane!`;
    }
    if (mem.kind === 'player_horn' && mem.valence < 0) {
      return `${who} mentioned you nearly startled folks with that horn near ${place} ${dayPhrase} — easy on the pedal!`;
    }
    return `${who} told me you crushed that ${detail} at ${place} ${dayPhrase}. Word travels fast around town!`;
  }

  // First-hand episodic memories
  if (mem.kind === 'player_gift') {
    if (speakerTone === 'analytical_dry') {
      return `Still appreciating that ${detail} you brought by ${place} ${dayPhrase} — genuinely thoughtful pick.`;
    }
    if (speakerTone === 'shy_gentle') {
      return `I still smile thinking about that ${detail} you gave me at ${place} ${dayPhrase}.`;
    }
    return `Still thinking about that ${detail} you brought me at ${place} ${dayPhrase} — best surprise all week!`;
  }

  if (mem.kind === 'player_basketball') {
    if (speakerTone === 'playful_bold') {
      return `My ears are still ringing from your ${detail} at ${place} ${dayPhrase} — Minh already wants a rematch!`;
    }
    return `Still impressed by your ${detail} over at ${place} ${dayPhrase} — clean form on the court!`;
  }

  if (mem.kind === 'player_shared_activity') {
    if (mem.valence < 0) {
      return `Missed you around ${place} ${dayPhrase} — let us catch up properly next time.`;
    }
    if (detail.includes('shift') || detail.includes('barista') || detail.includes('market') || detail.includes('library')) {
      return `We kept pace during that ${detail} at ${place} ${dayPhrase} without missing a beat — you have real rhythm!`;
    }
    if (detail.includes('acoustic')) {
      return `Still humming that ${detail} you played at ${place} ${dayPhrase} — the whole plaza stopped to listen!`;
    }
    return `Good seeing you again after our ${detail} at ${place} ${dayPhrase}!`;
  }

  if (mem.kind === 'player_horn') {
    if (mem.valence < 0) {
      return `Whoa — easy on the horn near ${place} ${dayPhrase}! You nearly gave me a start.`;
    }
    return `Still chuckling about your friendly horn wave near ${place} ${dayPhrase}!`;
  }

  if (mem.kind === 'player_vehicle_seen') {
    return `Spotted you rolling past ${place} in that ${detail} ${dayPhrase} — smooth cruise!`;
  }

  if (mem.kind === 'rain_shelter') {
    return `Good call ducking out of the rain near ${place} ${dayPhrase}.`;
  }

  return `Nice running into you again after catching up near ${place} ${dayPhrase}!`;
}

/**
 * Compose one deterministic beat (0..3) of a 4-beat NPC-to-NPC contextual English exchange.
 * Uses Big-5 temperament, affinity tier, weather, season, time-of-day, zone, reputation, and
 * episodic memory, while honoring the resident's `Uint16Array(8)` non-repetition ring buffer.
 */
export function composeBanterBeat(ctx: BanterBeatContext): BanterBeatResult {
  const actKey = ctx.activity ? ctx.activity.toLowerCase() : '';
  const resolvedTopic =
    TOPIC_DETAILS[ctx.topic] && ctx.topic !== 'general'
      ? ctx.topic
      : ACTIVITY_TOPIC_MAP[actKey] ?? (TOPIC_DETAILS[ctx.topic] ? ctx.topic : 'general');
  const topic = resolvedTopic;
  const baseDetails = TOPIC_DETAILS[topic] ?? TOPIC_DETAILS.general;
  const actDetails = actKey ? ACTIVITY_DETAILS[actKey] : undefined;
  const nextVenues = TOPIC_NEXT_VENUES[topic] ?? TOPIC_NEXT_VENUES.general;
  const phasePhrases = PHASE_TIME_PHRASE[ctx.phase] ?? PHASE_TIME_PHRASE.afternoon;
  const seasonFlavors = SEASON_FLAVOR[ctx.season] ?? SEASON_FLAVOR[0];

  const h = hashInt(
    `${ctx.speakerId}|${ctx.partnerId}|${topic}|${ctx.beat}|${ctx.zone}|${ctx.phase}|${ctx.currentDay}|${actKey}`,
    ctx.seed,
  );

  const detail =
    actDetails && (h & 3) === 0
      ? actDetails[(h >>> 2) % actDetails.length]
      : baseDetails[h % baseDetails.length];
  const hooks = TOPIC_HOOKS[topic] ?? TOPIC_HOOKS.general;
  const hook = hooks[(h >>> 14) % hooks.length];
  const moodTag = MOOD_TAG[ctx.mood] ?? 'easy pace';
  const nextVenue = nextVenues[(h >>> 4) % nextVenues.length];
  const time = phasePhrases[(h >>> 8) % phasePhrases.length];
  const seasonFlavor = seasonFlavors[(h >>> 12) % seasonFlavors.length];
  const zone = zoneDisplayName(ctx.zone);
  const season = SEASON_LABELS[ctx.season] ?? 'spring';
  const partner = cleanDisplayText(ctx.partnerName || ctx.partnerId);

  const vars: Record<string, string> = {
    detail,
    hook,
    moodTag,
    nextVenue,
    time,
    seasonFlavor,
    zone,
    season,
    partner,
    speaker: cleanDisplayText(ctx.speakerName || ctx.speakerId),
  };

  const toneOffset =
    ctx.tone === 'warm_extrovert' ? 100
      : ctx.tone === 'analytical_dry' ? 200
      : ctx.tone === 'shy_gentle' ? 300
      : 400;

  // Beat 0: Opener (priority: fresh memory/gossip > active weather > topic + tone)
  if (ctx.beat === 0) {
    if (ctx.memory && ctx.currentDay - ctx.memory.day <= 3 && ctx.memory.salience >= 0.6 && (h % 5) < 2) {
      const memText = composeGossipOpener(ctx.memory, ctx.currentDay, partner, ctx.witnessName);
      const id = 9000 + (hashInt(memText, ctx.seed) % 900);
      if (!inRing(ctx.recentIds, id)) {
        recordRing(ctx.recentIds, id);
        return { text: memText, templateId: id, beat: 0, topic, tone: ctx.tone, microCue: 'chat' };
      }
    }

    if (ctx.rainIntensity >= 0.65 || ctx.rainIntensity > 0.1 || ctx.snowIntensity > 0.4) {
      const wKey = ctx.rainIntensity >= 0.65 ? 'heavy_rain' : ctx.rainIntensity > 0.1 ? 'light_rain' : 'snow';
      const wPool = WEATHER_BEAT0[wKey][ctx.tone];
      const baseId = 5000 + toneOffset + (wKey === 'heavy_rain' ? 0 : wKey === 'light_rain' ? 20 : 40);
      const pick = pickNonRepeatingIndex(wPool.length, baseId, h, ctx.recentIds);
      return {
        text: fillTemplate(wPool[pick.idx], vars),
        templateId: pick.templateId,
        beat: 0,
        topic,
        tone: ctx.tone,
        microCue: 'chat',
      };
    }

    const pool = BEAT0_BY_TONE[ctx.tone];
    const topicIdx = Object.keys(TOPIC_DETAILS).indexOf(topic);
    const baseId = 1000 + toneOffset + Math.max(0, topicIdx) * 16;
    const pick = pickNonRepeatingIndex(pool.length, baseId, h, ctx.recentIds);
    return {
      text: fillTemplate(pool[pick.idx], vars),
      templateId: pick.templateId,
      beat: 0,
      topic,
      tone: ctx.tone,
      microCue: ctx.mood === 'excited' ? 'laugh' : 'chat',
    };
  }

  // Beat 1: Personality + Affinity-Modulated Reaction
  if (ctx.beat === 1) {
    const bank = ctx.affinity >= 35 ? BEAT1_HIGH : ctx.affinity < 0 ? BEAT1_GUARDED : BEAT1_MID;
    const bandOffset = ctx.affinity >= 35 ? 0 : ctx.affinity < 0 ? 40 : 20;
    const pool = bank[ctx.tone];
    const baseId = 2000 + toneOffset + bandOffset;
    const pick = pickNonRepeatingIndex(pool.length, baseId, h, ctx.recentIds);
    const microCue: BanterMicroCue =
      ctx.affinity >= 35 && (ctx.tone === 'playful_bold' || ctx.mood === 'cheerful' || ctx.mood === 'excited')
        ? 'laugh'
        : 'nod';
    return {
      text: fillTemplate(pool[pick.idx], vars),
      templateId: pick.templateId,
      beat: 1,
      topic,
      tone: ctx.tone,
      microCue,
    };
  }

  // Beat 2: Follow-up / Memory Callback / Reputation Buzz / Plan Hook
  if (ctx.beat === 2) {
    if (ctx.memory && ctx.currentDay - ctx.memory.day <= 3 && ctx.memory.salience >= 0.55) {
      const text = composeGossipFollowUp(ctx.memory, ctx.currentDay, partner, ctx.witnessName);
      const id = 9500 + (hashInt(text, ctx.seed) % 900);
      if (!inRing(ctx.recentIds, id)) {
        recordRing(ctx.recentIds, id);
        return { text, templateId: id, beat: 2, topic, tone: ctx.tone, microCue: 'chat' };
      }
    }

    if ((ctx.districtRep ?? 0) >= 60 && (h % 3) === 0) {
      const repLines = [
        `Have you noticed how warmly everyone at ${zone} greets our new neighbor lately, ${partner}?`,
        `Word around ${zone} is our neighbor has become a real regular — even ${nextVenue} saves them a good spot.`,
        `Honestly, ${partner}, having a dependable neighbor around ${zone} makes the whole district feel livelier.`,
      ];
      const pick = pickNonRepeatingIndex(repLines.length, 8200 + toneOffset, h, ctx.recentIds);
      return {
        text: cleanDisplayText(repLines[pick.idx]),
        templateId: pick.templateId,
        beat: 2,
        topic,
        tone: ctx.tone,
        microCue: 'nod',
      };
    }

    const pool = BEAT2_BY_TONE[ctx.tone];
    const topicIdx = Object.keys(TOPIC_DETAILS).indexOf(topic);
    const baseId = 3000 + toneOffset + Math.max(0, topicIdx) * 16;
    const pick = pickNonRepeatingIndex(pool.length, baseId, h, ctx.recentIds);
    return {
      text: fillTemplate(pool[pick.idx], vars),
      templateId: pick.templateId,
      beat: 2,
      topic,
      tone: ctx.tone,
      microCue: 'chat',
    };
  }

  // Beat 3: Natural Closer + Micro-Action Cue
  const pool = BEAT3_BY_TONE[ctx.tone];
  const baseId = 4000 + toneOffset;
  const pick = pickNonRepeatingIndex(pool.length, baseId, h, ctx.recentIds);
  const entry = pool[pick.idx];
  return {
    text: fillTemplate(entry.text, vars),
    templateId: pick.templateId,
    beat: 3,
    topic,
    tone: ctx.tone,
    microCue: entry.cue,
  };
}

function composeGossipOpener(
  mem: BanterMemoryCue,
  currentDay: number,
  partner: string,
  witnessName?: string,
): string {
  const place = zoneDisplayName(mem.zone);
  const detail = humanizeSubject(mem.subject, mem.kind);
  const when = relativeDayPhrase(Math.max(0, Math.floor(currentDay - mem.day)));
  if (mem.src) {
    const who = cleanDisplayText(witnessName || mem.src);
    return `Did you hear from ${who}, ${partner}? Our neighbor pulled off that ${detail} over at ${place} ${when}!`;
  }
  if (mem.kind === 'player_basketball') {
    return `You should have seen the ${detail} over at ${place} ${when}, ${partner} — the whole park cheered!`;
  }
  if (mem.kind === 'player_gift') {
    return `Our neighbor brought the nicest ${detail} by ${place} ${when}, ${partner} — really brightened the day.`;
  }
  return `Did you catch our neighbor helping out with that ${detail} at ${place} ${when}, ${partner}? Impressive pace!`;
}

function composeGossipFollowUp(
  mem: BanterMemoryCue,
  currentDay: number,
  partner: string,
  witnessName?: string,
): string {
  const place = zoneDisplayName(mem.zone);
  const detail = humanizeSubject(mem.subject, mem.kind);
  const when = relativeDayPhrase(Math.max(0, Math.floor(currentDay - mem.day)));
  if (mem.src) {
    const who = cleanDisplayText(witnessName || mem.src);
    return `Speaking of neighborhood news, ${who} mentioned that ${detail} at ${place} ${when} — folks are still smiling about it.`;
  }
  return `Reminds me, ${partner} — seeing that ${detail} at ${place} ${when} really raised everyone’s spirits around here.`;
}

/**
 * Compose a deterministic, memory-grounded sidewalk greeting for a resident encountering the player.
 * Zero LLM calls, 100% English-only, zero raw "&", zero emojis.
 */
export function composeMemoryGreeting(ctx: MemoryGreetingContext): string {
  if (ctx.isRival) {
    if (ctx.tone === 'analytical_dry') return 'Busy day — hope your numbers hold up.';
    return 'Packed schedule today — let us see if your plan keeps pace.';
  }

  // 1. Concrete episodic memory (within 3 game days, salient)
  if (ctx.memory && ctx.currentDay - ctx.memory.day <= 3 && ctx.memory.salience >= 0.55) {
    return formatMemoryRecollection(ctx.memory, ctx.currentDay, ctx.tone, ctx.witnessName);
  }

  // 2. Player vehicle comment
  if (ctx.vehicle) {
    const vName = cleanDisplayText(ctx.vehicle.name);
    if (ctx.vehicle.kind === 'car') {
      if (ctx.residentId === 'tuankiet' || ctx.residentId === 'ductri') {
        return `Clean handling on that ${vName}!`;
      }
      return ctx.tone === 'analytical_dry'
        ? `Smooth suspension on the ${vName} — watch the crosswalks.`
        : `Nice wheels on the ${vName} — enjoy the cruise!`;
    }
    if (ctx.vehicle.kind === 'motorbike') return 'Sharp ride! Watch the crosswalks.';
    return 'Great day to get around on two wheels!';
  }

  // 3. Weather awareness
  if (ctx.rainIntensity >= 0.85) {
    return ctx.tone === 'playful_bold'
      ? 'Serious downpour out here — sprint for dry cover!'
      : 'Quite a downpour — stay dry out here!';
  }
  if (ctx.rainIntensity > 0.1) {
    return ctx.rainTolerance >= 0.75
      ? 'Love how peaceful Riverside feels in the rain.'
      : 'Light rain makes warm tea sound amazing.';
  }
  if (ctx.snowIntensity > 0.4) {
    return 'Snow on Riverside Lane! Keep warm out there.';
  }

  // 4. District reputation recognition for Regular / Trusted Local / Riverside Pillar
  const repScore = ctx.districtRep?.score ?? 0;
  const place = zoneDisplayName(ctx.zone);
  if (repScore >= 85) {
    return `Always an honor seeing a Riverside Pillar around ${place}!`;
  }
  if (repScore >= 60 && ctx.friendship >= 25) {
    return `Good to see a trusted regular back at ${place} — your usual spot is waiting!`;
  }
  if (repScore >= 30 && ctx.friendship >= 15 && (hashInt(ctx.residentId, ctx.seed + ctx.currentDay) & 1) === 0) {
    return `Back at ${place} again! Everyone here knows your face by now.`;
  }

  // 5. Time-of-day, tone, and friendship warmth
  if (ctx.friendship >= 50) {
    if (ctx.phase === 'morning') return 'Morning, friend! Ready for a bright day?';
    if (ctx.phase === 'evening' || ctx.phase === 'night') return 'Hey friend! Love these lantern-lit evenings.';
    if (ctx.tone === 'playful_bold') return 'Hey! Ready to stir up something fun today?';
    if (ctx.tone === 'shy_gentle') return 'Oh, hi friend! Always glad when you drop by.';
    return 'Hey! Always good running into you.';
  }
  if (ctx.phase === 'morning') return 'Good morning along Riverside Lane!';
  if (ctx.phase === 'evening' || ctx.phase === 'night') return 'Quiet evening out here, isn’t it?';
  if (ctx.tone === 'analytical_dry') return 'Good afternoon — hope the semester stays on schedule.';
  return 'Hey there — hope your semester’s going well!';
}
