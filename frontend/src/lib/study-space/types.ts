/**
 * Không gian học tập — the shape of a learner's space. A layout is the FOREGROUND only: the room, the objects in it, the
 * character, the companion and the tools on screen. The background is never part of it: it belongs to Giao diện
 * (`lib/appearance/state.ts`), which keeps running whatever the layout holds — an empty layout shows the background alone.
 */

import type { WallpaperPreference } from '@/types/wallpaper';
import type { SpatialPreference } from '@/lib/spatial/preference';
import type { AppearanceTheme } from '@/lib/appearance/scope';
import type { AvatarLook } from '@/lib/avatar/look';
import type { RoomLife } from './life';
import type { FloorPose } from '@/lib/embodiment/posture';

export interface SpaceAppearance { mode: 'override'; wallpaper: WallpaperPreference; spatial: SpatialPreference; theme: AppearanceTheme }
export const LAYOUT_VERSION = 1;

export type RoomTheme = 'ocean' | 'rain' | 'library' | 'station' | 'plain';
/** `live` follows the clock and the weather; the others are the same scene at any hour. */
export type WindowView = 'ocean' | 'rain' | 'magic' | 'space' | 'day' | 'sunset' | 'night' | 'live';
export type FloorStyle = 'oak' | 'walnut' | 'tile' | 'carpet' | 'metal' | 'marble';
export type Particles = 'bubbles' | 'rain' | 'motes' | 'stars' | 'none';
export type Quality = 'high' | 'balanced' | 'low';

export interface RoomConfig {
  /** false = no walls, no floor, no window: objects stand on an invisible floor over the background. */
  visible: boolean;
  theme: RoomTheme;
  wallLeft: boolean;
  wallRight: boolean;
  floor: boolean;
  base: boolean;
  wallColor: string;
  accentColor: string;
  floorStyle: FloorStyle;
  windowView: WindowView;
  particles: Particles;
  /** 0 night … 1 bright day: drives the key light, the window and the practical lamps. */
  daylight: number;
  /** Room size in metres (square footprint). */
  size: number;
  /** The casement window stands open. Missing in older layouts: closed. */
  windowOpen?: boolean;
  /** How far the curtains are drawn across the window, 0..1. Missing: open. */
  curtains?: number;
}

export type Vec3 = [number, number, number];

export interface SpaceObject {
  id: string;
  /** Catalogue id (`lib/study-space/catalog.ts`). */
  kind: string;
  pos: Vec3;
  rotY: number;
  scale: number;
  hidden?: boolean;
  locked?: boolean;
  group?: string;
  /** Optional tint replacing the item's main colour. */
  color?: string;
  /** What a click does in use mode; default = the catalogue's own action. */
  action?: ActionId | null;
  /** Missing keeps legacy lamps on. */
  lightOn?: boolean;
  /** A thing left lying on its side: the whole rotation. Missing = upright, by rotY. */
  quat?: [number, number, number, number];
  /** How far each drawer is pulled, 0..1. Missing = shut. */
  drawers?: number[];
  /** It lies in this drawer: `pos` and `rotY` are then in the drawer's own space. */
  inside?: { host: string; slot: number };
  state?: ObjectState;
}

/** What the thing has been left doing. Everything optional: an object nobody touched has none of it. */
export interface ObjectState {
  on?: boolean;
  /** A laptop's lid: 1 open, 0 shut. */
  lid?: number;
  /** A picture hanging crooked, radians. */
  tilt?: number;
  /** How many times an hourglass has been turned over, and when last. */
  flip?: number;
  flipAt?: number;
  /** Sips left in a mug. */
  sips?: number;
  /** Which books have left a row or a stack. */
  taken?: number[];
  /** The reading this book holds, and the page it was left open at. */
  material?: number;
  page?: number;
  /** A book of the learner's own library: which one it is, and enough to draw its cover. The book itself stays where it lives. */
  book?: BookInfo;
  /** A mop or a cloth: how wet, how much dirt it has taken up (0..1). */
  wet?: number;
  load?: number;
  /** A bucket's water, a dustpan's or a bin's contents (0..1 of what it holds), and how dirty a bucket's water has become. */
  fill?: number;
  dirt?: number;
  /** What is in a kettle, pot or cup: how hot, 0 room to 1 boiling, and how strong the tea has got. */
  temp?: number;
  tea?: number;
  /** A plant: how damp its earth is, 0..1, how much it has grown. */
  soil?: number;
  growth?: number;
  /** A lamp whose bulb has gone. */
  burnt?: boolean;
}
export type BookRef = { source: 'mybooks'; id: string } | { source: 'reading'; id: number } | { source: 'bilingual'; id: number };
export type BookInfo = BookRef & { title: string; author: string; color: string };

export type CharacterModel = 'LYRA' | 'KAI';
export type Activity = 'idle' | 'study' | 'read' | 'write' | 'type' | 'listen' | 'relax' | 'sleep' | 'stretch' | 'wave';

export interface CharacterConfig {
  visible: boolean;
  model: CharacterModel;
  hair: string;
  top: string;
  bottom: string;
  shoes: string;
  /** Before the wardrobe: one thing on the head. Read for old layouts only, and never as headphones nobody chose. */
  accessory: 'none' | 'headphones' | 'glasses' | 'cap';
  /** What is worn: `lib/avatar/look.ts`. Missing: the character's own tailoring. */
  look?: AvatarLook;
  /** When this choice was made: the newer of this and the account's record wins. */
  lookAt?: number;
  pos: Vec3;
  rotY: number;
  /** Where it rests and what it does when nothing else asked it to move. */
  anchor: string | null;
  activity: Activity;
  /** Settled floor action, with its stage position and heading. */
  floorPose?: FloorPose;
  /** Follow the focus timer: sit and study while a focus session runs, stretch at the end. */
  followFocus: boolean;
}

export interface PetConfig {
  visible: boolean;
  kind: 'echo';
  roam: boolean;
}

export type WidgetType =
  | 'focus' | 'tasks' | 'note' | 'clock' | 'calendar' | 'music' | 'ambient' | 'flashcards' | 'path' | 'stats'
  | 'dictionary' | 'links' | 'countdown' | 'quote';

export interface Widget {
  id: string;
  type: WidgetType;
  /** Top-left corner as a fraction of the viewport (0…1): positions survive a resize. */
  x: number;
  y: number;
  /** Size in CSS pixels (clamped to the viewport on render). */
  w: number;
  h: number;
  z: number;
  hidden?: boolean;
  locked?: boolean;
  opacity?: number;
  /** The record it shows (a note id, a task filter …): removing the widget never deletes it. */
  refId?: string | null;
  settings?: Record<string, string | number | boolean | null>;
}

export interface CameraConfig {
  /** Optional in v1 layouts; older rooms keep their overview. */
  view?: 'overview' | 'first' | 'third' | 'desk';
  yaw?: number;
  pitch?: number;
  azimuth: number;
  polar: number;
  zoom: number;
  target: Vec3;
}

export interface Layout {
  v: number;
  /** Missing = inherit the website. References and tuning only; the existing engines own all assets. */
  appearance?: SpaceAppearance;
  room: RoomConfig;
  objects: SpaceObject[];
  character: CharacterConfig;
  pet: PetConfig;
  widgets: Widget[];
  camera: CameraConfig;
  /** Room group placement on screen: lets the learner shrink the room into a corner to see more background. */
  stage: { scale: number; offsetX: number; offsetZ: number };
  quality: Quality;
  /** What time has done to the room, and what has happened in it: never part of its design. */
  life?: RoomLife;
}

export type ActionId =
  | 'open:focus' | 'open:planner' | 'open:notebook' | 'open:research' | 'open:ambient' | 'open:character' | 'toggle:music'
  | 'route:reading' | 'route:mybooks' | 'route:listening' | 'route:speaking' | 'route:writing' | 'route:flashcards'
  | 'route:grammar' | 'route:path' | 'route:progress' | 'route:exams' | 'route:games' | 'route:dictionary'
  | 'character:sit' | 'character:sleep' | 'character:read' | 'none';

export interface SpaceSummary {
  id: string;
  name: string;
  position: number;
  active: boolean;
  hasDefault: boolean;
  defaultSavedAt: string | null;
  revision: number;
  updatedAt: string;
}

export interface SpaceRecord {
  id: string;
  name: string;
  position: number;
  active: boolean;
  layout: unknown;
  defaultLayout: unknown | null;
  defaultSavedAt: string | null;
  revision: number;
  updatedAt: string;
}

export interface SnapshotSummary {
  id: string;
  kind: 'MANUAL' | 'BEFORE_CLEAR' | 'BEFORE_RESTORE' | 'BEFORE_DEFAULT' | 'BEFORE_TEMPLATE';
  label: string | null;
  createdAt: string;
}

export interface StudyTask {
  id: string;
  title: string;
  notes: string | null;
  status: 'OPEN' | 'DOING' | 'DONE';
  priority: number;
  dueOn: string | null;
  project: string | null;
  recurrence: 'NONE' | 'DAILY' | 'WEEKLY';
  doneCount: number;
  lastDoneOn: string | null;
  position: number;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  focusedSeconds: number;
}

export interface StudyNote {
  id: string;
  kind: 'NOTE' | 'BOARD';
  title: string;
  body: string;
  color: 'sun' | 'rose' | 'mint' | 'sky' | 'lilac' | 'sand';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FocusSessionRecord {
  id: string;
  mode: 'POMODORO' | 'COUNTDOWN' | 'STOPWATCH';
  status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED';
  plannedSeconds: number;
  focusedSeconds: number;
  taskId: string | null;
  label: string | null;
  subject: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface FocusStats {
  days: { day: string; focusedSeconds: number; completed: number; interrupted: number }[];
  totalSeconds: number;
  completed: number;
  interrupted: number;
  bySubject: Record<string, number>;
  byTask: Record<string, number>;
  streakDays: number;
  recent: FocusSessionRecord[];
}

export interface Annotation {
  id: string;
  page: number;
  quote: string;
  note: string;
  color: string;
  bookmark?: boolean;
  createdAt: string;
  /** SHA-256 of the local PDF bytes; absent on legacy page quotes. */
  documentHash?: string;
  /** PDF user-space coordinates, independent of zoom, rotation and device pixels. */
  rects?: [number, number, number, number][];
}

export interface ResearchItem {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  project: string | null;
  tags: string | null;
  favorite: boolean;
  fileName: string | null;
  fileSize: number | null;
  lastPage: number;
  annotations: Annotation[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}
