import type { WidgetType } from './types';

/** CSS pixels, including the header. One contract for insert, restore, pointer and keyboard resize. */
export const WIDGET_GEOMETRY: Record<WidgetType, { min: [number, number]; initial: [number, number] }> = {
  focus: { min: [264, 280], initial: [304, 340] },
  tasks: { min: [280, 220], initial: [304, 292] },
  note: { min: [224, 180], initial: [264, 240] },
  clock: { min: [224, 124], initial: [260, 144] },
  calendar: { min: [280, 330], initial: [320, 356] },
  music: { min: [300, 140], initial: [380, 148] },
  ambient: { min: [280, 300], initial: [320, 340] },
  flashcards: { min: [240, 210], initial: [280, 232] },
  path: { min: [280, 220], initial: [320, 300] },
  stats: { min: [280, 254], initial: [320, 280] },
  dictionary: { min: [280, 220], initial: [320, 280] },
  links: { min: [280, 264], initial: [320, 280] },
  countdown: { min: [280, 230], initial: [320, 250] },
  quote: { min: [240, 160], initial: [304, 190] },
};

export function widgetSize(type: WidgetType, w: number, h: number, viewport = { w: 1616, h: 1216 }) {
  const { min, initial } = WIDGET_GEOMETRY[type];
  return {
    w: Math.min(Math.max(min[0], Number.isFinite(w) ? w : initial[0]), Math.max(1, viewport.w - 16)),
    h: Math.min(Math.max(min[1], Number.isFinite(h) ? h : initial[1]), Math.max(1, viewport.h - 16)),
  };
}
