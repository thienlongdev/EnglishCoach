import { create } from 'zustand';
import { emptyLayout, uid } from './layout';
import type { Layout, SpaceObject, Widget } from './types';

/**
 * The editor of the open space: the working layout, edit / use mode, the selection and the undo history. Every
 * change goes through `apply`, which records history (consecutive changes of the same drag coalesce) and bumps
 * `version` for the auto-save. Records shown by widgets (notes, tasks …) are not here: removing a widget only removes
 * the widget.
 */

export type Selection = string; // object id, `w:<widget id>`, 'character', 'pet', 'room'
const HISTORY = 80;
/** Where the player walked and looked is not a change to the room: it is never a step of Undo, and Undo never moves the player. */
const VIEW_ONLY = new Set(['camera', 'char-move', 'char-anchor', 'char-activity', 'life', 'tool-state']);
/** Undo takes back what was arranged, never what was cleaned or how the day went: `life` stays what it is now. */
const keepPlayer = (restored: Layout, now: Layout): Layout => ({ ...restored, life: now.life, camera: now.camera, character: { ...restored.character, pos: now.character.pos, rotY: now.character.rotY, anchor: now.character.anchor, activity: now.character.activity } });

interface SpaceStore {
  layout: Layout;
  mode: 'use' | 'edit';
  selection: Selection[];
  past: Layout[];
  future: Layout[];
  version: number;
  mergeKey: string | null;
  clipboard: { objects: SpaceObject[]; widgets: Widget[] } | null;
  load: (layout: Layout) => void;
  apply: (fn: (l: Layout) => Layout, merge?: string) => void;
  undo: () => void;
  redo: () => void;
  setMode: (m: 'use' | 'edit') => void;
  select: (ids: Selection[], additive?: boolean) => void;
  copy: () => void;
  paste: () => void;
}

export const useSpace = create<SpaceStore>((set, get) => ({
  layout: emptyLayout(),
  mode: 'use',
  selection: [],
  past: [],
  future: [],
  version: 0,
  mergeKey: null,
  clipboard: null,
  load: (layout) => set({ layout, past: [], future: [], selection: [], mergeKey: null }),
  apply: (fn, merge) => {
    const { layout, past, mergeKey, version } = get();
    const next = fn(layout);
    if (next === layout) return;
    if (merge && VIEW_ONLY.has(merge)) { set({ layout: next, version: version + 1 }); return; }
    const coalesce = merge && merge === mergeKey;
    set({ layout: next, past: coalesce ? past : [...past.slice(-HISTORY + 1), layout], future: [], version: version + 1, mergeKey: merge ?? null });
  },
  undo: () => {
    const { past, layout, future, version } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ layout: keepPlayer(prev, layout), past: past.slice(0, -1), future: [layout, ...future].slice(0, HISTORY), version: version + 1, mergeKey: null });
  },
  redo: () => {
    const { past, layout, future, version } = get();
    const next = future[0];
    if (!next) return;
    set({ layout: keepPlayer(next, layout), past: [...past, layout].slice(-HISTORY), future: future.slice(1), version: version + 1, mergeKey: null });
  },
  setMode: (mode) => set({ mode, selection: mode === 'use' ? [] : get().selection }),
  select: (ids, additive) => {
    const cur = get().selection;
    if (!additive) return set({ selection: ids });
    const s = new Set(cur);
    ids.forEach((id) => (s.has(id) ? s.delete(id) : s.add(id)));
    set({ selection: [...s] });
  },
  copy: () => {
    const { layout, selection } = get();
    const objects = layout.objects.filter((o) => selection.includes(o.id));
    const widgets = layout.widgets.filter((w) => selection.includes(`w:${w.id}`));
    if (objects.length || widgets.length) set({ clipboard: { objects, widgets } });
  },
  paste: () => {
    const { clipboard, apply, select } = get();
    if (!clipboard) return;
    const objects = clipboard.objects.map((o) => ({ ...o, id: uid('o'), pos: [o.pos[0] + 0.3, o.pos[1], o.pos[2] + 0.3] as SpaceObject['pos'], locked: false }));
    const widgets = clipboard.widgets.map((w) => ({ ...w, id: uid('w'), x: Math.min(0.9, w.x + 0.02), y: Math.min(0.9, w.y + 0.03), z: w.z + 1 }));
    apply((l) => ({ ...l, objects: [...l.objects, ...objects], widgets: [...l.widgets, ...widgets] }));
    select([...objects.map((o) => o.id), ...widgets.map((w) => `w:${w.id}`)]);
  },
}));

/** Helpers that edit one part of the layout. */
export const ops = {
  object: (id: string, patch: Partial<SpaceObject>, merge?: string) =>
    useSpace.getState().apply((l) => ({ ...l, objects: l.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) }), merge),
  objects: (ids: string[], fn: (o: SpaceObject) => SpaceObject, merge?: string) =>
    useSpace.getState().apply((l) => ({ ...l, objects: l.objects.map((o) => (ids.includes(o.id) ? fn(o) : o)) }), merge),
  widget: (id: string, patch: Partial<Widget>, merge?: string) =>
    useSpace.getState().apply((l) => ({ ...l, widgets: l.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }), merge),
  addObject: (o: SpaceObject) => {
    useSpace.getState().apply((l) => ({ ...l, objects: [...l.objects, o] }));
    useSpace.getState().select([o.id]);
  },
  addWidget: (w: Widget) => {
    const top = Math.max(10, ...useSpace.getState().layout.widgets.map((x) => x.z)) + 1;
    useSpace.getState().apply((l) => ({ ...l, widgets: [...l.widgets, { ...w, z: top, hidden: false }] }));
  },
  removeSelected: () => {
    const { selection, apply, select } = useSpace.getState();
    apply((l) => ({
      ...l,
      objects: l.objects.filter((o) => !selection.includes(o.id) || o.locked),
      widgets: l.widgets.filter((w) => !selection.includes(`w:${w.id}`) || w.locked),
      character: selection.includes('character') ? { ...l.character, visible: false } : l.character,
      pet: selection.includes('pet') ? { ...l.pet, visible: false } : l.pet,
      room: selection.includes('room') ? { ...l.room, visible: false } : l.room,
    }));
    select([]);
  },
  duplicateSelected: () => {
    useSpace.getState().copy();
    useSpace.getState().paste();
  },
  layer: (dir: 1 | -1) => {
    const { selection, apply } = useSpace.getState();
    apply((l) => {
      const zs = l.widgets.map((w) => w.z);
      const top = Math.max(10, ...zs), bottom = Math.min(10, ...zs);
      return { ...l, widgets: l.widgets.map((w) => (selection.includes(`w:${w.id}`) ? { ...w, z: dir > 0 ? top + 1 : Math.max(1, bottom - 1) } : w)) };
    });
  },
  group: () => {
    const { selection } = useSpace.getState();
    const g = uid('g');
    ops.objects(selection, (o) => ({ ...o, group: g }));
  },
  ungroup: () => {
    const { selection } = useSpace.getState();
    ops.objects(selection, (o) => ({ ...o, group: undefined }));
  },
};
