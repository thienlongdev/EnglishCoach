import type { RoomLife } from './life';

/**
 * Small stories that come out of how the room really is. One part watches (the facts, read from the world), one part decides (what may begin, with room between
 * stories), and the words are only ever a line at the bottom of the screen that goes away by itself. A beat ends when what it speaks of has become true, however that
 * happened and in whatever order: there is no objective to tick, no failing, and never anything standing between the learner and learning.
 */
export interface Facts {
  now: number;
  hour: number;
  weekend: boolean;
  /** The first time in this room today. */
  firstToday: boolean;
  awayHours: number;
  hasWindow: boolean;
  hasRoom: boolean;
  curtains: number;
  windowOpen: boolean;
  rain: number;
  /** Rain falling on the floor through the open window, or water under it, m². */
  wetUnderWindow: number;
  wet: number;
  dust: number;
  /** 0..1, 1 spotless. */
  clean: number;
  stains: number;
  crumbs: number;
  webs: number;
  trash: number;
  heap: boolean;
  hasKit: boolean;
  /** What the hands have in them, by catalogue kind. */
  held: string[];
  mopLoad: number;
  mopWet: number;
  panFill: number;
  panHeld: boolean;
  bucketDirt: number;
  bucketFill: number;
  binFull: boolean;
  atDesk: boolean;
  onScreen: boolean;
  bookOpen: boolean;
  lampOn: boolean;
  busy: boolean;
  /** A friend's message or invitation that has not been opened. */
  unread: number;
  invited: boolean;
  /** Footprints: wet soles. */
  wetSoles: boolean;
  /** Something fell over and spilled just now. */
  spilled: boolean;
  /** The kettle is hot now, the pot has tea in it, and how the plants and the lamps are. */
  kettleHot?: boolean;
  teaReady?: boolean;
  cupHasTea?: boolean;
  plantDry?: boolean;
  bulbBurnt?: boolean;
  hasKettle?: boolean;
}
export interface Phrase { en: string; vi: string }
export interface Line { id: string; vi: string; en: string; phrase?: Phrase; hold?: number }
interface Beat extends Line {
  /** This beat is done: the story moves on, saying nothing. */
  done: (f: Facts) => boolean;
  /** Not spoken unless this is true, but also not in the way. */
  when?: (f: Facts) => boolean;
}
export interface Story {
  id: string; title: { vi: string; en: string }; every: number; begin: (f: Facts) => boolean; beats: Beat[]; end?: Line; stale?: number;
  /** A later beat that has come true makes the earlier ones moot: nobody is sent back to do what they chose to skip. */
  onward?: boolean;
}

const H = 3_600_000;
export const STORIES: Story[] = [
  {
    id: 'morning', title: { vi: 'Một buổi sáng yên tĩnh', en: 'A quiet morning' }, every: 18 * H, onward: true,
    begin: f => f.hasRoom && f.hour >= 5 && f.hour < 11 && f.firstToday && f.rain < .2,
    beats: [
      { id: 'light', vi: 'Trời sáng rồi. Ánh sáng đang đợi sau tấm rèm.', en: 'It is morning. The light is waiting behind the curtain.', phrase: { en: 'open the curtains', vi: 'kéo rèm ra' }, when: f => f.hasWindow && f.curtains > .3, done: f => !f.hasWindow || f.curtains < .3 },
      { id: 'sit', vi: 'Bàn học vẫn ở đó từ hôm qua. Ngồi xuống đi.', en: 'The desk is as you left it. Sit down.', phrase: { en: 'sit at the desk', vi: 'ngồi vào bàn' }, done: f => f.atDesk },
      { id: 'begin', vi: 'Hôm nay bắt đầu từ đâu? Mở máy, hoặc một cuốn sách.', en: 'Where to start today? The computer, or a book.', done: f => f.onScreen || f.bookOpen },
    ],
    end: { id: 'morning-end', vi: 'Buổi sáng là của bạn.', en: 'The morning is yours.' },
  },
  {
    id: 'rain', title: { vi: 'Chiều mưa', en: 'A rainy afternoon' }, every: 6 * H, stale: 40 * 60_000,
    begin: f => f.hasRoom && f.rain > .3 && f.hasWindow,
    beats: [
      { id: 'starts', vi: 'Mưa rồi. Nghe tiếng trên cửa kính không?', en: 'It has started to rain. Hear it on the glass?', hold: 4.5, done: f => f.windowOpen || f.wet > .05 || f.rain < .1 },
      { id: 'blows', vi: 'Mưa đang hắt qua cửa sổ, sàn bắt đầu ướt.', en: 'The rain is blowing in, and the floor is getting wet.', phrase: { en: 'close the window', vi: 'đóng cửa sổ' }, when: f => f.windowOpen && f.rain > .2, done: f => !f.windowOpen || f.rain < .1 },
      { id: 'puddle', vi: 'Dưới cửa sổ còn đọng nước. Lau đi kẻo mang đi khắp phòng.', en: 'There is water under the window. Dry it before you walk it around.', phrase: { en: 'wipe up the water', vi: 'lau chỗ nước' }, when: f => f.wetUnderWindow > .12, done: f => f.wetUnderWindow < .05 },
      { id: 'lamp', vi: 'Trời tối đi nhiều. Bật đèn cho ấm một chút?', en: 'It has gone dark out. A lamp, perhaps?', phrase: { en: 'turn on the lamp', vi: 'bật đèn' }, when: f => !f.lampOn, done: f => f.lampOn || f.rain < .1 },
    ],
    end: { id: 'rain-end', vi: 'Mưa như thế này hợp để đọc sách.', en: 'This is reading weather.' },
  },
  {
    id: 'clean', title: { vi: 'Dọn nhà cuối tuần', en: 'A weekend clean' }, every: 5 * 24 * H, stale: 4 * H,
    begin: f => f.hasRoom && (f.dust > .22 || f.clean < .62 || (f.weekend && f.clean < .82)),
    beats: [
      { id: 'see', vi: 'Bụi đã bám một lớp rồi. Nhìn dưới ánh sáng là thấy.', en: 'A layer of dust has settled. You can see it where the light falls.', hold: 5, done: f => f.held.some(h => h.startsWith('tool.')) || !f.hasKit },
      { id: 'kit', vi: 'Chưa có đồ dọn trong phòng. Mở Thao tác nhanh để lấy một bộ.', en: 'No cleaning things in here yet. Quick actions can bring a set.', when: f => !f.hasKit, done: f => f.hasKit },
      { id: 'tool', vi: 'Chổi ở trên giá. Quét từ góc phòng ra giữa.', en: 'The broom is on the rack. Sweep from the corners towards the middle.', phrase: { en: 'sweep the floor', vi: 'quét nhà' }, when: f => f.hasKit && !f.heap, done: f => f.heap || f.dust < .1 },
      { id: 'pan', vi: 'Gom được một đống rồi. Hốt nó lên bằng ki.', en: 'That is a heap. Get it up with the dustpan.', phrase: { en: 'use the dustpan', vi: 'dùng cái ki' }, when: f => f.heap, done: f => !f.heap },
      { id: 'mop', vi: 'Giờ đến giẻ lau. Nhúng vào xô, vắt, rồi lau.', en: 'Now the mop. Dip it, wring it, then go over the floor.', phrase: { en: 'mop the floor', vi: 'lau nhà' }, when: f => f.stains > 0 || f.dust > .05, done: f => (f.stains === 0 && f.dust < .08) || f.wet > .6 },
    ],
    end: { id: 'clean-end', vi: 'Phòng thở khác hẳn.', en: 'The room breathes differently now.' },
  },
  {
    id: 'tea', title: { vi: 'Một ấm trà', en: 'A pot of tea' }, every: 20 * H, stale: 50 * 60_000, onward: true,
    begin: f => f.hasRoom && !!f.hasKettle && (f.hour >= 14 && f.hour < 18 || f.rain > .3) && !f.onScreen,
    beats: [
      { id: 'boil', vi: 'Giờ này hợp với một tách trà. Ấm đun đang ở trên bàn.', en: 'A cup of tea would suit this hour. The kettle is on the desk.', phrase: { en: 'boil the kettle', vi: 'đun nước' }, done: f => !!f.kettleHot || !!f.teaReady || !!f.cupHasTea },
      { id: 'pour', vi: 'Nước sôi rồi. Rót vào ấm trà, đợi một lát cho trà ngấm.', en: 'It has boiled. Pour it into the teapot and give it a moment to brew.', phrase: { en: 'let the tea brew', vi: 'để trà ngấm' }, done: f => !!f.teaReady || !!f.cupHasTea },
      { id: 'cup', vi: 'Trà đã ngấm. Rót ra tách đi.', en: 'The tea has brewed. Pour yourself a cup.', phrase: { en: 'pour a cup of tea', vi: 'rót một tách trà' }, done: f => !!f.cupHasTea },
    ],
    end: { id: 'tea-end', vi: 'Nóng vừa. Mang lại bàn hay ra cửa sổ cũng được.', en: 'Just hot enough. Take it to the desk, or the window.' },
  },
  {
    id: 'friend', title: { vi: 'Chuẩn bị đón bạn', en: 'Getting ready for a friend' }, every: 12 * H, stale: 30 * 60_000,
    begin: f => f.hasRoom && (f.unread > 0 || f.invited),
    beats: [
      { id: 'note', vi: 'Có người nhắn cho bạn. Máy tính trên bàn đang sáng.', en: 'Someone has written to you. The computer on the desk is lit.', done: f => f.onScreen || f.unread === 0 },
      { id: 'tidy', vi: 'Phòng còn hơi bừa nếu có khách. Dọn qua một chút?', en: 'A bit untidy for company. A quick tidy?', phrase: { en: 'tidy up the room', vi: 'dọn phòng' }, when: f => f.clean < .7 || f.trash > 0, done: f => f.clean >= .7 && f.trash === 0 },
      { id: 'door', vi: 'Cửa ra Speaking Arena ở phía sau bạn. Khi nào sẵn sàng thì đi qua.', en: 'The door to Speaking Arena is behind you. Go through when you are ready.', when: f => f.invited, done: f => !f.invited },
    ],
  },
];

/** One-time remarks about how things work, each said the first time it is true, and never again in this room. */
export const REMARKS: (Line & { when: (f: Facts) => boolean })[] = [
  { id: 'mop-dirty', vi: 'Giẻ đã bẩn: nó đang để lại vệt. Nhúng lại vào xô.', en: 'The mop is dirty and leaving streaks. Dip it in the bucket again.', when: f => f.held.includes('tool.mop') && f.mopLoad > .62 },
  { id: 'mop-dry', vi: 'Giẻ khô rồi, chỉ đẩy được bụi. Nhúng vào xô đi.', en: 'The mop has dried out. Dip it in the bucket.', when: f => f.held.includes('tool.mop') && f.mopWet < .1 },
  { id: 'water-dirty', vi: 'Nước trong xô đục rồi. Đổ đi và lấy nước mới ở bồn rửa.', en: 'The bucket water has gone murky. Pour it out and refill at the sink.', phrase: { en: 'change the water', vi: 'thay nước' }, when: f => f.bucketDirt > .6 },
  { id: 'pan-full', vi: 'Ki đã đầy. Đổ vào thùng rác đã.', en: 'The dustpan is full. Empty it into the bin.', phrase: { en: 'empty the dustpan', vi: 'đổ ki rác' }, when: f => f.panHeld && f.panFill > .9 },
  { id: 'bin-full', vi: 'Thùng rác đầy rồi. Buộc túi lại và mang ra cửa.', en: 'The bin is full. Tie the bag and take it to the door.', phrase: { en: 'take out the trash', vi: 'đổ rác' }, when: f => f.binFull },
  { id: 'wet-soles', vi: 'Giày ướt: dấu chân đang theo bạn đi khắp phòng.', en: 'Wet shoes: your footprints are following you around.', when: f => f.wetSoles },
  { id: 'spill', vi: 'Đổ rồi. Nước không tự biến mất đâu.', en: 'It spilled. Water does not clean itself up.', when: f => f.spilled },
  { id: 'plant-dry', vi: 'Đất trong chậu khô rồi, lá bắt đầu rũ xuống.', en: 'The earth in the pot has dried out, and the leaves are starting to droop.', phrase: { en: 'water the plant', vi: 'tưới cây' }, when: f => !!f.plantDry },
  { id: 'bulb', vi: 'Bóng đèn cháy rồi. Có một bóng dự phòng ở trên bàn.', en: 'The bulb has gone. There is a spare on the desk.', phrase: { en: 'change the bulb', vi: 'thay bóng đèn' }, when: f => !!f.bulbBurnt },
  { id: 'webs', vi: 'Góc trần có mạng nhện. Cái chổi cán dài với tới được.', en: 'There is a cobweb up in the corner. The long brush can reach it.', phrase: { en: 'remove the cobweb', vi: 'quét mạng nhện' }, when: f => f.webs > 0 && f.held.includes('tool.webbrush') },
];

export interface DirectorOut { line: Line | null; memoryChanged: boolean }
const QUIET_MS = 14_000, BETWEEN_STORIES = 25 * 60_000;

/**
 * Watches the facts and decides: at most one line at a time, some quiet after it, some room between stories, and a story that has nowhere to go ends without a word.
 * Nothing here ever changes the world.
 */
export class StoryDirector {
  private lastLine = -Infinity;
  private spokenBeat = '';
  constructor(private life: RoomLife) {}
  use(life: RoomLife) { this.life = life; }
  get current() { const m = this.life.story; return m ? STORIES.find(s => s.id === m.id) ?? null : null; }
  /** Called about once a second. `quietNow`: the hands are in the middle of something, or a screen or panel is up. */
  update(f: Facts, quietNow: boolean): DirectorOut {
    const life = this.life;
    let changed = false, line: Line | null = null;
    if (!life.settings.stories) return { line: null, memoryChanged: false };
    const canSpeak = f.now - this.lastLine > QUIET_MS && !quietNow;
    // A remark comes first: it is about what is in the hands right now.
    if (canSpeak) {
      const r = REMARKS.find(x => !life.said.includes(x.id) && x.when(f));
      if (r) { life.said = [...life.said, r.id].slice(-64); this.lastLine = f.now; return { line: r, memoryChanged: true }; }
    }
    let story = this.current;
    if (story && life.story) {
      const m = life.story;
      // Past what a beat speaks of: on, without a word. Whatever is already true is never asked for.
      while (m.beat < story.beats.length && story.beats[m.beat].done(f)) { m.beat++; m.at = f.now; changed = true; }
      if (story.onward) for (let i = story.beats.length - 1; i > m.beat; i--) if (story.beats[i].done(f)) { m.beat = i + 1; m.at = f.now; changed = true; break; }
      if (m.beat >= story.beats.length) {
        if (story.end && canSpeak) { line = story.end; this.lastLine = f.now; }
        // Its closing words only fit the moment: an hour later, coming back from the screen, they would be noise.
        else if (story.end && !canSpeak && f.now - m.at < 45_000) return { line: null, memoryChanged: changed };
        life.told[story.id] = f.now; life.story = null; this.spokenBeat = ''; changed = true;
        return { line, memoryChanged: changed };
      }
      if (f.now - m.at > (story.stale ?? 90 * 60_000)) { life.told[story.id] = f.now; life.story = null; this.spokenBeat = ''; return { line: null, memoryChanged: true }; }
      const beat = story.beats[m.beat], key = `${story.id}:${beat.id}`;
      // A broom in the hands: nobody needs telling about curtains now.
      if (story.id !== 'clean' && f.held.some(h => h.startsWith('tool.'))) return { line: null, memoryChanged: changed };
      if (canSpeak && this.spokenBeat !== key && (!beat.when || beat.when(f))) { this.spokenBeat = key; this.lastLine = f.now; return { line: beat, memoryChanged: changed }; }
      return { line: null, memoryChanged: changed };
    }
    // Who may begin: with room since the last, and only when nothing else is going on.
    if (!quietNow) {
      const last = Math.max(0, ...Object.values(life.told));
      if (f.now - last < BETWEEN_STORIES) return { line: null, memoryChanged: changed };
      story = STORIES.find(s => f.now - (life.told[s.id] ?? 0) >= s.every && s.begin(f)) ?? null;
      if (story) { life.story = { id: story.id, beat: 0, at: f.now }; this.spokenBeat = ''; changed = true; }
    }
    return { line: null, memoryChanged: changed };
  }
}
