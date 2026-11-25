import type { GuideEntry } from './store';
import { legacyView } from '@/lib/navigation/routes';
import type { GuideDef, GuideModule, GuideText } from './types';
import { CORE_GUIDES } from './guides/core';
import { GAME_GUIDES } from './guides/games';
import { GRAMMAR_GUIDES } from './guides/grammar';
import { ODYSSEY_GUIDES } from './guides/odyssey';
import { SKILL_GUIDES } from './guides/skills';

/** Every guide, in the order the panel lists them. See `docs/development/developer-guide.md` when adding new feature guides. */
export const allGuides: GuideDef[] = [...CORE_GUIDES, ...ODYSSEY_GUIDES, ...GRAMMAR_GUIDES, ...SKILL_GUIDES, ...GAME_GUIDES];

export const MODULE_LABEL: Record<GuideModule, GuideText> = {
  workspace: { vi: 'Làm quen', en: 'Getting started' },
  dashboard: { vi: 'Trang chủ', en: 'Home' },
  learningPath: { vi: 'Lộ trình học', en: 'Learning Path' },
  flashcards: { vi: 'Thẻ từ vựng', en: 'Flashcards' },
  grammar: { vi: 'Ngữ pháp', en: 'Grammar' },
  reading: { vi: 'Đọc', en: 'Reading' },
  listening: { vi: 'Nghe', en: 'Listening' },
  speaking: { vi: 'Nói', en: 'Speaking' },
  writing: { vi: 'Viết', en: 'Writing' },
  exams: { vi: 'Thi thử', en: 'Mock exams' },
  games: { vi: 'Trò chơi', en: 'Games' },
  appearance: { vi: 'Giao diện', en: 'Appearance' },
  music: { vi: 'Âm nhạc', en: 'Music' },
  community: { vi: 'Cộng đồng', en: 'Community' },
  account: { vi: 'Tài khoản', en: 'Account' },
};

const byId = new Map(allGuides.map((def) => [def.id, def]));
export const guideById = (id: string) => byId.get(id) ?? null;

export function routeMatches(def: GuideDef, path: string, query: string | null) {
  const { pathname, tab } = legacyView(path, query);
  const pathOk = typeof def.path === 'string' ? def.path === pathname : def.path.test(pathname);
  if (!pathOk) return false;
  // `/` with no tab is the public Landing, not the dashboard.
  return def.tab === undefined || def.tab === tab;
}

/** What Echo may offer here, once: the orientation first, then the most specific guide this screen has that this account has never been offered. */
export function nextOffer(pathname: string, tab: string | null, seen: Record<string, GuideEntry>): GuideDef | null {
  const fresh = allGuides.filter((def) => def.offer && !seen[def.id] && routeMatches(def, pathname, tab));
  if (!fresh.length) return null;
  // A feature that is really open on screen comes before the module's general introduction.
  const open = fresh.filter((def) => def.level === 'feature' && def.gate && document.querySelector(def.gate));
  if (open.length) return open[0];
  const general = fresh.filter((def) => def.level !== 'feature');
  return general[0] ?? fresh.find((def) => !def.gate) ?? null;
}
