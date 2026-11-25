'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUpToLine, Armchair, Brush, Camera, Clock3, Copy, Eraser, Eye, EyeOff, Group, History, Image as ImageIcon, LayoutTemplate, Lock,
  LockOpen, Music2, NotebookPen, Package, PencilRuler, Pin, PinOff, Redo2, RotateCcw, RotateCw, Save, Search, Shirt, Star, Trash2,
  Undo2, Ungroup, Volume2, BookOpenText, CalendarDays, Timer, Waves, Plus,
} from 'lucide-react';
import { CATALOG, CATALOG_BY_ID, CATEGORY_LABEL, ACTION_LABEL, type CatalogCategory } from '@/lib/study-space/catalog';
import { DEFAULT_SETTINGS, type RoomLifeSettings } from '@/lib/study-space/life';
import { THEME_LABEL, newWidget, roomFor } from '@/lib/study-space/layout';
import { AXIS_META_3D } from '@/lib/study-space/keymap';
import {
  EXACT_UPRIGHT_MIN_UP_Y,
  applyAxisRotation3D,
  eulerDegreesFromQuat,
  isSpaceObjectUpright,
  normalizeSpaceObjectOrientation,
  quatFromEulerDegrees,
  quatFromSpaceObject,
  resetSpaceObjectUprightPatch,
  tiltDegreesFromQuat,
  type RotationAxis3D,
} from '@/lib/study-space/orientation';
import { ops, useSpace } from '@/lib/study-space/store';
import { NAMED_ROOM } from '@/lib/study-space/api';
import type { ActionId, Layout, RoomTheme, SnapshotSummary, SpaceSummary, WidgetType } from '@/lib/study-space/types';
import { WIDGET_META } from './widgets';
import s from './studySpace.module.css';
import VfxSettings from '@/components/vfx/VfxSettings';
import { echoSrc } from '@/lib/brand/echoCharacters';

export type Section = 'items' | 'furniture' | 'decor' | 'study' | 'notes' | 'clock' | 'sound' | 'wallpaper' | 'space' | 'character' | 'layout';

export interface ToolbarApi {
  thumbnail: (kind: string) => string | null;
  beginDrag: (kind: string, e: React.PointerEvent) => void;
  addObject: (kind: string) => void;
  openPanel: (p: string) => void;
  openAppearance: () => void;
  saveLayout: () => Promise<void>;
  saveDefault: () => Promise<void>;
  restoreDefault: () => Promise<void>;
  askResetRoom: () => void;
  clearAll: () => Promise<void>;
  askClear: () => void;
  undoClear: () => Promise<void>;
  canUndoClear: boolean;
  saveNamedRoom: (name: string) => Promise<boolean>;
  openNamedRoom: (id: string) => Promise<void>;
  removeNamedRoom: (id: string) => Promise<void>;
  applyTemplate: (t: RoomTheme) => Promise<void>;
  snapshots: () => Promise<SnapshotSummary[]>;
  restoreSnapshot: (id: string) => Promise<void>;
  spaces: SpaceSummary[];
  activeSpaceId: string | null;
  hasDefault: boolean;
  switchSpace: (id: string) => Promise<void>;
  createSpace: (name: string, from: 'empty' | 'copy' | RoomTheme) => Promise<void>;
  renameSpace: (id: string, name: string) => Promise<void>;
  deleteSpace: (id: string) => Promise<void>;
  resetCamera: () => void;
  exit: () => void;
  world3d: boolean;
}

const SECTIONS: { id: Section; label: string; labelEn: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'items', label: 'Vật phẩm', labelEn: 'Items', icon: Package },
  { id: 'furniture', label: 'Nội thất', labelEn: 'Furniture', icon: Armchair },
  { id: 'decor', label: 'Trang trí', labelEn: 'Decor', icon: Star },
  { id: 'study', label: 'Công cụ học tập', labelEn: 'Study Tools', icon: PencilRuler },
  { id: 'notes', label: 'Ghi chú', labelEn: 'Notes', icon: NotebookPen },
  { id: 'clock', label: 'Đồng hồ', labelEn: 'Clock', icon: Clock3 },
  { id: 'sound', label: 'Âm thanh', labelEn: 'Audio', icon: Volume2 },
  { id: 'wallpaper', label: 'Giao diện', labelEn: 'Appearance', icon: ImageIcon },
  { id: 'space', label: 'Không gian', labelEn: 'Space', icon: LayoutTemplate },
  { id: 'character', label: 'Nhân vật', labelEn: 'Avatar', icon: Shirt },
  { id: 'layout', label: 'Bố cục', labelEn: 'Layout', icon: History },
];

const SECTION_CATS: Partial<Record<Section, CatalogCategory[]>> = {
  furniture: ['furniture', 'care'], decor: ['decor', 'plants', 'lighting'], study: ['study'], clock: ['clock'], sound: ['sound'], notes: [],
};
const SECTION_WIDGETS: Partial<Record<Section, WidgetType[]>> = {
  study: ['focus', 'tasks', 'flashcards', 'path', 'stats', 'dictionary', 'links', 'calendar'], notes: ['note', 'quote'], clock: ['clock', 'focus', 'countdown', 'calendar'],
  sound: ['music', 'ambient'],
};

export function TopReveal({ api, open, pinned, onPin, section, setSection, onKeep, vi = true }: {
  api: ToolbarApi; open: boolean; pinned: boolean; onPin: () => void; section: Section | null; setSection: (s: Section | null) => void; onKeep: (keep: boolean) => void; vi?: boolean;
}) {
  const mode = useSpace((st) => st.mode);
  const canUndo = useSpace((st) => st.past.length > 0);
  const canRedo = useSpace((st) => st.future.length > 0);
  const [q, setQ] = useState('');
  return (
    <div className={`${s.topBar} ${open ? s.topBarOpen : ''}`} data-testid="study-toolbar" aria-hidden={!open}
      onPointerEnter={() => onKeep(true)} onPointerLeave={() => onKeep(false)} onFocusCapture={() => onKeep(true)}>
      <div className={s.glass} style={{ borderRadius: 26 }}>
        <div className={s.barRow}>
          <div className={s.brand}>
            <img src={echoSrc('official', 32)} alt="" width={30} height={30} />
            <div>{vi ? 'Không gian học tập' : 'Echo Life · Study Space'}<small>{vi ? 'Góc học của riêng bạn' : 'Your interactive English world'}</small></div>
          </div>
          <nav className={s.tabs} aria-label={vi ? 'Công cụ không gian' : 'Space tools'}>
            {SECTIONS.map((x) => (
              <button key={x.id} type="button" className={`${s.tab} ${section === x.id ? s.tabActive : ''}`} aria-pressed={section === x.id}
                onClick={() => { if (x.id === 'wallpaper') { api.openAppearance(); return; } setSection(section === x.id ? null : x.id); }} data-testid={`tool-${x.id}`}>
                <x.icon size={18} />{vi ? x.label : x.labelEn}
              </button>
            ))}
          </nav>
          <button type="button" className={`${s.btn} ${mode === 'edit' ? s.primary : ''}`} onClick={() => useSpace.getState().setMode(mode === 'edit' ? 'use' : 'edit')} data-testid="tool-edit" aria-pressed={mode === 'edit'}>
            <Brush size={15} /> {mode === 'edit' ? (vi ? 'Xong chỉnh sửa' : 'Done editing') : (vi ? 'Chỉnh sửa' : 'Edit room')}
          </button>
          <button type="button" className={s.iconBtn} onClick={() => useSpace.getState().undo()} disabled={!canUndo} aria-label={vi ? 'Hoàn tác' : 'Undo'} title={vi ? 'Hoàn tác (Ctrl+Z)' : 'Undo (Ctrl+Z)'}><Undo2 size={16} /></button>
          <button type="button" className={s.iconBtn} onClick={() => useSpace.getState().redo()} disabled={!canRedo} aria-label={vi ? 'Làm lại' : 'Redo'} title={vi ? 'Làm lại (Ctrl+Y)' : 'Redo (Ctrl+Y)'}><Redo2 size={16} /></button>
          <button type="button" className={s.iconBtn} onClick={onPin} aria-pressed={pinned} aria-label={pinned ? (vi ? 'Bỏ ghim thanh công cụ' : 'Unpin toolbar') : (vi ? 'Ghim thanh công cụ' : 'Pin toolbar')} title={pinned ? (vi ? 'Bỏ ghim' : 'Unpin') : (vi ? 'Ghim thanh công cụ' : 'Pin toolbar')}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
          <button type="button" className={s.btn} onClick={api.exit} data-testid="tool-exit"><ArrowLeft size={15} /> {vi ? 'Quay lại English Coach' : 'Back to English Coach'}</button>
        </div>
        <div className={s.barRow} style={{ paddingTop: 0 }}>
          <button type="button" className={s.btn} onClick={() => void api.saveLayout()} data-testid="tool-save"><Save size={15} /> {vi ? 'Lưu bố cục' : 'Save layout'}</button>
          <button type="button" className={s.btn} onClick={() => void api.saveDefault()} data-testid="tool-save-default"><Star size={15} /> {vi ? 'Lưu làm mặc định của tôi' : 'Save as default'}</button>
          <button type="button" className={s.btn} onClick={() => void api.restoreDefault()} data-testid="tool-restore-default"><RotateCcw size={15} /> {vi ? 'Trở về mặc định' : 'Restore default'}</button>
          <button type="button" className={s.btn} onClick={() => api.askResetRoom()} data-testid="tool-reset-room"><RotateCcw size={15} /> {vi ? 'Đặt lại phòng' : 'Reset Room'}</button>
          <button type="button" className={s.btn} onClick={() => setSection('layout')}><History size={15} /> {vi ? 'Khôi phục phiên bản trước' : 'Version history'}</button>
          <button type="button" className={s.btn} onClick={() => setSection('space')}><LayoutTemplate size={15} /> {vi ? 'Không gian của tôi' : 'My spaces'}</button>
          <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => api.askClear()} data-testid="tool-clear"><Eraser size={15} /> {vi ? 'Xóa trắng' : 'Clear room'}</button>
          <span className={s.hint} style={{ marginLeft: 'auto' }}>{vi ? 'Esc mở hoặc đóng thanh này · E để chỉnh sửa' : 'Esc toggles this bar · E edits room'}</span>
        </div>
        {section && (
          <div className={s.drawer}>
            <Drawer section={section} api={api} q={q} setQ={setQ} vi={vi} />
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ kind, api }: { kind: string; api: ToolbarApi }) {
  const item = CATALOG_BY_ID[kind];
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => { const url = api.thumbnail(kind); if (alive) setSrc(url); }, 20);
    return () => { alive = false; clearTimeout(id); };
  }, [kind, api]);
  return (
    <button type="button" className={s.tile} data-testid={`item-${kind}`} title={`Kéo vào phòng hoặc bấm để thêm: ${item.name}`}
      onPointerDown={(e) => api.beginDrag(kind, e)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.addObject(kind); } }}>
      {src ? <img src={src} alt="" /> : <span className={s.thumb}><Package size={28} /></span>}
      {item.name}
      <span className={s.tileSub}>{CATEGORY_LABEL[item.category]}</span>
    </button>
  );
}

function WidgetTile({ type }: { type: WidgetType }) {
  const meta = WIDGET_META[type];
  return (
    <button type="button" className={s.tile} onClick={() => ops.addWidget(newWidget(type, 0.3 + Math.random() * 0.2, 0.25 + Math.random() * 0.2))} data-testid={`widget-${type}`}>
      <span className={s.thumb}><meta.icon size={34} /></span>
      {meta.label}
      <span className={s.tileSub}>Công cụ trên màn hình</span>
    </button>
  );
}

function PanelTile({ label, icon: Icon, onClick, vi = true }: { label: string; icon: React.ComponentType<{ size?: number }>; onClick: () => void; vi?: boolean }) {
  return (
    <button type="button" className={s.tile} onClick={onClick}>
      <span className={s.thumb}><Icon size={34} /></span>{label}<span className={s.tileSub}>{vi ? 'Mở cửa sổ đầy đủ' : 'Open full window'}</span>
    </button>
  );
}

function Drawer({ section, api, q, setQ, vi = true }: { section: Section; api: ToolbarApi; q: string; setQ: (v: string) => void; vi?: boolean }) {
  const items = useMemo(() => {
    const cats = SECTION_CATS[section];
    return CATALOG.filter((i) => !i.unlisted).filter((i) => (section === 'items' ? true : cats?.includes(i.category))).filter((i) => !q || `${i.name} ${i.nameEn}`.toLowerCase().includes(q.toLowerCase()));
  }, [section, q]);
  const widgets = SECTION_WIDGETS[section] ?? [];
  if (section === 'space') return <SpaceDrawer api={api} />;
  if (section === 'layout') return <LayoutDrawer api={api} />;
  if (section === 'character') return <CharacterDrawer api={api} />;
  const sec = SECTIONS.find((x) => x.id === section);
  return (
    <>
      <div className={s.drawerHead}>
        <div className={s.drawerTitle}>{vi ? sec?.label : sec?.labelEn}</div>
        {section === 'items' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, maxWidth: 320 }}>
            <Search size={15} /><input className={s.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={vi ? 'Tìm vật phẩm…' : 'Search items…'} aria-label={vi ? 'Tìm vật phẩm' : 'Search items'} />
          </label>
        )}
        <span className={s.hint}>{api.world3d ? (vi ? 'Kéo một vật vào phòng; khung xanh là chỗ đặt được, đỏ là chỗ bị vướng. Bấm (hoặc Enter) để đặt vào chỗ trống.' : 'Drag an item into the room; green fits, red is blocked. Click (or press Enter) to place in an open spot.') : (vi ? 'Thêm một vật sẽ bật lại cảnh 3D phía trước hình nền.' : 'Adding an item re-enables the 3D scene.')}</span>
      </div>
      <div className={s.grid}>
        {section === 'study' && <PanelTile vi={vi} label={vi ? 'Kế hoạch' : 'Planner'} icon={CalendarDays} onClick={() => api.openPanel('planner')} />}
        {section === 'study' && <PanelTile vi={vi} label={vi ? 'Học cùng nhau' : 'Study Together'} icon={BookOpenText} onClick={() => api.openPanel('shared')} />}
        {section === 'study' && <PanelTile vi={vi} label={vi ? 'Góc nghiên cứu' : 'Research Desk'} icon={BookOpenText} onClick={() => api.openPanel('research')} />}
        {section === 'study' && <PanelTile vi={vi} label={vi ? 'Đồng hồ tập trung' : 'Focus Timer'} icon={Timer} onClick={() => api.openPanel('focus')} />}
        {section === 'notes' && <PanelTile vi={vi} label={vi ? 'Sổ ghi chú' : 'Notebook'} icon={NotebookPen} onClick={() => api.openPanel('notebook')} />}
        {section === 'sound' && <PanelTile vi={vi} label={vi ? 'Bộ trộn âm thanh nền' : 'Ambient Mixer'} icon={Waves} onClick={() => api.openPanel('ambient')} />}
        {section === 'sound' && <PanelTile vi={vi} label={vi ? 'Âm nhạc' : 'Music'} icon={Music2} onClick={() => api.openPanel('music')} />}
        {widgets.map((w) => <WidgetTile key={w} type={w} />)}
        {items.map((i) => <Tile key={i.id} kind={i.id} api={api} />)}
      </div>
    </>
  );
}

const THEMES: { id: RoomTheme; swatch: string }[] = [
  { id: 'ocean', swatch: 'linear-gradient(135deg,#9fb4ee,#7c8cf0 55%,#5b7be0)' },
  { id: 'rain', swatch: 'linear-gradient(135deg,#e8d9c8,#9a6a46 55%,#2c3561)' },
  { id: 'library', swatch: 'linear-gradient(135deg,#d9cdea,#8e78d4 55%,#c9a046)' },
  { id: 'station', swatch: 'linear-gradient(135deg,#dfe3f3,#7dd3fc 55%,#25283d)' },
  { id: 'plain', swatch: 'linear-gradient(135deg,#f4f2fb,#e9e5f7)' },
];

function SpaceDrawer({ api }: { api: ToolbarApi }) {
  const room = useSpace((st) => st.layout.room);
  const stage = useSpace((st) => st.layout.stage);
  const quality = useSpace((st) => st.layout.quality);
  const setRoom = (patch: Partial<Layout['room']>, merge?: string) => useSpace.getState().apply((l) => ({ ...l, room: { ...l.room, ...patch } }), merge);
  const life = useSpace((st) => st.layout.life?.settings);
  const setLife = (patch: Partial<RoomLifeSettings>) => useSpace.getState().apply((l) => (l.life ? { ...l, life: { ...l.life, settings: { ...(l.life.settings ?? DEFAULT_SETTINGS), ...patch } } } : l), 'life');
  const setStage = (patch: Partial<Layout['stage']>) => useSpace.getState().apply((l) => ({ ...l, stage: { ...l.stage, ...patch } }), `stage-${Object.keys(patch).join()}`);
  const [name, setName] = useState('');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Không gian của tôi</div>
        <div className={s.list} style={{ maxHeight: 220 }}>
          {api.spaces.map((sp) => (
            <div key={sp.id} className={`${s.row} ${sp.id === api.activeSpaceId ? s.rowActive : ''}`} style={{ cursor: 'default' }}>
              <input className={s.input} style={{ flex: 1, padding: '4px 8px' }} defaultValue={sp.name} maxLength={60} aria-label="Tên không gian"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== sp.name) void api.renameSpace(sp.id, v); }} />
              {sp.hasDefault && <span className={s.chip} title="Có bố cục mặc định riêng"><Star size={11} /></span>}
              {sp.id !== api.activeSpaceId && <button type="button" className={s.btn} style={{ padding: '4px 8px' }} onClick={() => void api.switchSpace(sp.id)}>Mở</button>}
              <button type="button" className={`${s.iconBtn} ${s.danger}`} disabled={api.spaces.length <= 1} onClick={() => { if (window.confirm(`Xóa không gian “${sp.name}”? Ghi chú, việc cần làm và tài liệu của bạn không bị xóa.`)) void api.deleteSpace(sp.id); }} aria-label={`Xóa ${sp.name}`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input className={s.input} style={{ flex: 1, minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên không gian mới" maxLength={60} aria-label="Tên không gian mới" />
          <button type="button" className={s.btn} onClick={() => void api.createSpace(name.trim() || 'Không gian mới', 'empty').then(() => setName(''))}><Plus size={14} /> Trống</button>
          <button type="button" className={s.btn} onClick={() => void api.createSpace(name.trim() || 'Bản sao', 'copy').then(() => setName(''))}><Copy size={14} /> Sao chép</button>
        </div>
      </section>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Mẫu phòng</div>
        <p className={s.hint} style={{ marginBottom: 8 }}>Mẫu chỉ là điểm bắt đầu: mọi vật trong mẫu đều là của bạn để dời, đổi hay xóa. Bố cục đang dùng được giữ lại trong “phiên bản trước”.</p>
        <div className={s.grid} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))' }}>
          {THEMES.map((t) => (
            <button key={t.id} type="button" className={s.tile} onClick={() => { if (window.confirm(`Dùng mẫu “${THEME_LABEL[t.id]}” cho không gian này?`)) void api.applyTemplate(t.id); }} data-testid={`template-${t.id}`}>
              <span style={{ width: 84, height: 54, borderRadius: 12, background: t.swatch }} />{THEME_LABEL[t.id]}
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Căn phòng</div>
        <div className={s.fieldRow} style={{ marginBottom: 8 }}>
          {([['visible', 'Phòng'], ['wallLeft', 'Tường trái'], ['wallRight', 'Tường phải'], ['floor', 'Sàn'], ['base', 'Bệ phòng']] as const).map(([k, l]) => (
            <label key={k} className={s.chip} style={{ cursor: 'pointer' }}><input type="checkbox" checked={room[k]} onChange={(e) => setRoom({ [k]: e.target.checked })} /> {l}</label>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label className={s.field}>Màu tường<input type="color" value={room.wallColor} onChange={(e) => setRoom({ wallColor: e.target.value }, 'wall-color')} /></label>
          <label className={s.field}>Màu dải sáng<input type="color" value={room.accentColor} onChange={(e) => setRoom({ accentColor: e.target.value }, 'accent-color')} /></label>
          <label className={s.field}>Sàn
            <select className={s.select} value={room.floorStyle} onChange={(e) => setRoom({ floorStyle: e.target.value as Layout['room']['floorStyle'] })}>
              {([['oak', 'Gỗ sồi'], ['walnut', 'Gỗ óc chó'], ['tile', 'Gạch'], ['carpet', 'Thảm'], ['metal', 'Kim loại'], ['marble', 'Đá cẩm thạch']] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className={s.field}>Cảnh ngoài cửa sổ
            <select className={s.select} value={room.windowView} onChange={(e) => setRoom({ windowView: e.target.value as Layout['room']['windowView'] })}>
              {([['ocean', 'Dưới đại dương'], ['rain', 'Mưa đêm thành phố'], ['magic', 'Lâu đài hoàng hôn'], ['space', 'Vũ trụ'], ['day', 'Trời ban ngày'], ['sunset', 'Hoàng hôn'], ['night', 'Đêm trăng'], ['live', 'Theo giờ thật và thời tiết']] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className={s.field}>Hiệu ứng
            <select className={s.select} value={room.particles} onChange={(e) => setRoom({ particles: e.target.value as Layout['room']['particles'] })}>
              {([['none', 'Không'], ['bubbles', 'Bong bóng'], ['motes', 'Bụi sáng'], ['stars', 'Ánh sao']] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className={s.field}>Chất lượng đồ họa
            <select className={s.select} value={quality} onChange={(e) => useSpace.getState().apply((l) => ({ ...l, quality: e.target.value as Layout['quality'] }))}>
              <option value="high">Cao</option><option value="balanced">Cân bằng</option><option value="low">Nhẹ</option>
            </select></label>
          <VfxSettings />
          <label className={s.field}>Bụi bặm theo thời gian
            <select className={s.select} data-testid="life-care" value={life?.care ?? 'natural'} onChange={(e) => setLife({ care: e.target.value as RoomLifeSettings['care'] })}>
              <option value="natural">Tự nhiên</option><option value="relaxed">Nhẹ nhàng</option><option value="off">Không bao giờ bẩn</option>
            </select></label>
          <label className={s.chip} style={{ cursor: 'pointer' }}><input type="checkbox" data-testid="life-stories" checked={life?.stories !== false} onChange={(e) => setLife({ stories: e.target.checked })} /> Câu chuyện trong phòng</label>
          <label className={s.chip} style={{ cursor: 'pointer' }}><input type="checkbox" data-testid="life-words" checked={life?.words !== false} onChange={(e) => setLife({ words: e.target.checked })} /> Gợi ý cụm từ tiếng Anh</label>
          <label className={s.chip} style={{ cursor: 'pointer' }}><input type="checkbox" data-testid="life-weather" checked={life?.weather !== false} onChange={(e) => setLife({ weather: e.target.checked })} /> Thời tiết</label>
          <label className={s.chip} style={{ cursor: 'pointer' }}><input type="checkbox" data-testid="life-weather-sound" checked={life?.weatherSound === true} disabled={life?.weather === false} onChange={(e) => setLife({ weatherSound: e.target.checked })} /> Âm thanh mưa và gió</label>
          <label className={s.field}>Ánh sáng ngày · đêm<input className={s.range} type="range" min={0} max={1} step={0.05} value={room.daylight} onChange={(e) => setRoom({ daylight: Number(e.target.value) }, 'daylight')} /></label>
          <label className={s.field}>Kích thước phòng<input className={s.range} type="range" min={4} max={9} step={0.5} value={room.size} onChange={(e) => setRoom({ size: Number(e.target.value) }, 'size')} /></label>
          <label className={s.field}>Thu nhỏ cả cảnh<input className={s.range} type="range" min={0.3} max={1.6} step={0.05} value={stage.scale} onChange={(e) => setStage({ scale: Number(e.target.value) })} /></label>
          <label className={s.field}>Dời cảnh sang ngang<input className={s.range} type="range" min={-8} max={8} step={0.1} value={stage.offsetX} onChange={(e) => setStage({ offsetX: Number(e.target.value) })} /></label>
          <label className={s.field}>Dời cảnh lên xuống<input className={s.range} type="range" min={-8} max={8} step={0.1} value={stage.offsetZ} onChange={(e) => setStage({ offsetZ: Number(e.target.value) })} /></label>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button type="button" className={s.btn} onClick={api.resetCamera}><Camera size={14} /> Đặt lại góc nhìn</button>
          <button type="button" className={s.btn} onClick={() => setRoom({ ...roomFor(room.theme, true), size: room.size })}>Màu gốc của mẫu</button>
        </div>
      </section>
    </div>
  );
}

const KIND_LABEL: Record<SnapshotSummary['kind'], string> = {
  MANUAL: 'Bản đã lưu', BEFORE_CLEAR: 'Trước khi xóa trắng', BEFORE_RESTORE: 'Trước khi khôi phục', BEFORE_DEFAULT: 'Mặc định cũ', BEFORE_TEMPLATE: 'Trước khi đổi mẫu',
};

function LayoutDrawer({ api }: { api: ToolbarApi }) {
  const [snaps, setSnaps] = useState<SnapshotSummary[] | null>(null);
  const [roomName, setRoomName] = useState('');
  const objects = useSpace((st) => st.layout.objects);
  const widgets = useSpace((st) => st.layout.widgets);
  const activeSpaceId = api.activeSpaceId;
  const reload = () => api.snapshots().then(setSnaps).catch(() => setSnaps([]));
  useEffect(() => { void reload(); }, [activeSpaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const named = snaps?.filter((sn) => sn.label?.startsWith(NAMED_ROOM)) ?? [];
  const versions = snaps?.filter((sn) => !sn.label?.startsWith(NAMED_ROOM)) ?? null;
  const hiddenCount = objects.filter((o) => o.hidden).length + widgets.filter((w) => w.hidden).length;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Bố cục</div>
        <p className={s.hint}>“Mặc định của tôi” là bố cục bạn tự chọn: Xóa trắng không bao giờ ghi đè nó. {api.hasDefault ? 'Không gian này đã có mặc định riêng.' : 'Không gian này chưa có mặc định riêng.'}</p>
        <div className={s.fieldRow} style={{ marginTop: 8 }}>
          <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void api.saveDefault()}><Star size={14} /> Lưu làm mặc định của tôi</button>
          <button type="button" className={s.btn} onClick={() => void api.restoreDefault()}><RotateCcw size={14} /> Trở về mặc định</button>
          <button type="button" className={s.btn} disabled={!hiddenCount} onClick={() => useSpace.getState().apply((l) => ({ ...l, objects: l.objects.map((o) => ({ ...o, hidden: false })), widgets: l.widgets.map((w) => ({ ...w, hidden: false })) }))}>
            <Eye size={14} /> Hiện lại {hiddenCount} vật đã ẩn
          </button>
        </div>
      </section>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Phòng đã lưu của tôi</div>
        <form className={s.fieldRow} style={{ marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); const n = roomName.trim(); if (!n) return; void api.saveNamedRoom(n).then((ok) => { if (ok) { setRoomName(''); void reload(); } }); }}>
          <input className={s.input} style={{ flex: 1, minWidth: 120 }} value={roomName} maxLength={40} placeholder="Đặt tên cho căn phòng này" aria-label="Tên phòng" onChange={(e) => setRoomName(e.target.value)} data-testid="room-name" />
          <button type="submit" className={`${s.btn} ${s.primary}`} disabled={!roomName.trim()} data-testid="room-save"><Save size={14} /> Lưu phòng</button>
        </form>
        {api.canUndoClear && <button type="button" className={s.btn} style={{ marginBottom: 8 }} onClick={() => void api.undoClear().then(reload)} data-testid="room-undo-clear"><RotateCcw size={14} /> Khôi phục phòng trước khi xóa trắng</button>}
        <div className={s.list} style={{ maxHeight: 200 }}>
          {snaps !== null && named.length === 0 && <div className={s.hint}>Chưa có phòng nào. Phòng đã lưu không bị thay thế khi bạn đổi hay xóa trắng căn phòng hiện tại.</div>}
          {named.map((sn) => (
            <div key={sn.id} className={s.row} style={{ cursor: 'default' }} data-testid="room-item">
              <span style={{ flex: 1, minWidth: 0 }}><b>{sn.label!.slice(NAMED_ROOM.length)}</b> <span className={s.hint}>{new Date(sn.createdAt).toLocaleString('vi-VN')}</span></span>
              <button type="button" className={s.btn} style={{ padding: '4px 10px' }} onClick={() => void api.openNamedRoom(sn.id).then(reload)} data-testid="room-open">Mở</button>
              <button type="button" className={s.iconBtn} aria-label={`Xóa phòng đã lưu ${sn.label!.slice(NAMED_ROOM.length)}`} onClick={() => { if (window.confirm(`Xóa phòng đã lưu “${sn.label!.slice(NAMED_ROOM.length)}”? Căn phòng hiện tại không bị ảnh hưởng.`)) void api.removeNamedRoom(sn.id).then(reload); }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Phiên bản trước</div>
        <div className={s.list} style={{ maxHeight: 240 }}>
          {snaps === null && <div className={s.hint}>Đang tải…</div>}
          {versions?.length === 0 && <div className={s.hint}>Chưa có phiên bản nào. “Lưu bố cục”, “Xóa trắng” hay đổi mẫu đều giữ lại bản trước.</div>}
          {versions?.map((sn) => (
            <div key={sn.id} className={s.row} style={{ cursor: 'default' }}>
              <span style={{ flex: 1 }}><b>{sn.label || KIND_LABEL[sn.kind]}</b> <span className={s.hint}>{new Date(sn.createdAt).toLocaleString('vi-VN')}</span></span>
              <button type="button" className={s.btn} style={{ padding: '4px 10px' }} onClick={() => void api.restoreSnapshot(sn.id)}>Khôi phục</button>
            </div>
          ))}
        </div>
      </section>
      <LayersList />
    </div>
  );
}

function LayersList() {
  const objects = useSpace((st) => st.layout.objects);
  const widgets = useSpace((st) => st.layout.widgets);
  const selection = useSpace((st) => st.selection);
  return (
    <section>
      <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Các lớp</div>
      <div className={s.list} style={{ maxHeight: 240 }}>
        {widgets.map((w) => (
          <div key={w.id} className={`${s.row} ${selection.includes(`w:${w.id}`) ? s.rowActive : ''}`} onClick={() => { useSpace.getState().setMode('edit'); useSpace.getState().select([`w:${w.id}`]); }}>
            <span style={{ flex: 1 }}>{WIDGET_META[w.type].label}</span>
            <button type="button" className={s.iconBtn} onClick={(e) => { e.stopPropagation(); ops.widget(w.id, { hidden: !w.hidden }); }} aria-label="Ẩn hoặc hiện">{w.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button type="button" className={s.iconBtn} onClick={(e) => { e.stopPropagation(); ops.widget(w.id, { locked: !w.locked }); }} aria-label="Khóa hoặc mở khóa">{w.locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
          </div>
        ))}
        {objects.map((o) => (
          <div key={o.id} className={`${s.row} ${selection.includes(o.id) ? s.rowActive : ''}`} onClick={() => { useSpace.getState().setMode('edit'); useSpace.getState().select([o.id]); }}>
            <span style={{ flex: 1 }}>{CATALOG_BY_ID[o.kind]?.name ?? `Vật không còn trong thư viện (${o.kind})`}</span>
            <button type="button" className={s.iconBtn} onClick={(e) => { e.stopPropagation(); ops.object(o.id, { hidden: !o.hidden }); }} aria-label="Ẩn hoặc hiện">{o.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button type="button" className={s.iconBtn} onClick={(e) => { e.stopPropagation(); ops.object(o.id, { locked: !o.locked }); }} aria-label="Khóa hoặc mở khóa">{o.locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function CharacterDrawer({ api }: { api: ToolbarApi }) {
  const ch = useSpace((st) => st.layout.character);
  const pet = useSpace((st) => st.layout.pet);
  return (
    <div className={s.fieldRow}>
      <label className={s.chip} style={{ cursor: 'pointer', padding: '6px 12px' }}><input type="checkbox" checked={ch.visible} onChange={(e) => useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, visible: e.target.checked } }))} /> Hiện nhân vật</label>
      <label className={s.chip} style={{ cursor: 'pointer', padding: '6px 12px' }}><input type="checkbox" checked={pet.visible} onChange={(e) => useSpace.getState().apply((l) => ({ ...l, pet: { ...l.pet, visible: e.target.checked } }))} /> Echo bơi quanh phòng</label>
      <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => api.openPanel('character')}><Shirt size={14} /> Tùy chỉnh nhân vật</button>
    </div>
  );
}

// ── Inspector (edit mode) ─────────────────────────────────────────────────────────────────────────────────
const ACTIONS = Object.keys(ACTION_LABEL) as ActionId[];

export function Inspector({ onCharacter }: { onCharacter: () => void }) {
  const selection = useSpace((st) => st.selection);
  const layout = useSpace((st) => st.layout);
  const objs = layout.objects.filter((o) => selection.includes(o.id));
  const wids = layout.widgets.filter((w) => selection.includes(`w:${w.id}`));
  const ref = useRef<HTMLDivElement>(null);
  if (!selection.length) return null;
  const one = objs.length === 1 && !wids.length ? objs[0] : null;
  const oneW = wids.length === 1 && !objs.length ? wids[0] : null;
  const item = one ? CATALOG_BY_ID[one.kind] : null;
  const oneQuat = one ? quatFromSpaceObject(one) : null;
  const oneUpright = one ? isSpaceObjectUpright(one, null, EXACT_UPRIGHT_MIN_UP_Y) : true;
  const oneTiltDeg = oneQuat ? Math.round(tiltDegreesFromQuat(oneQuat)) : 0;
  const eulerDeg = oneQuat ? eulerDegreesFromQuat(oneQuat) : { x: 0, y: 0, z: 0 };
  const anyTilted = objs.some((o) => !isSpaceObjectUpright(o, null, EXACT_UPRIGHT_MIN_UP_Y));

  const stepAxis = (axis: RotationAxis3D, deltaRad: number) => {
    if (!one || !oneQuat) return;
    const nextQ = applyAxisRotation3D(oneQuat, axis, deltaRad, axis === 'y' ? 'world' : 'local');
    ops.object(one.id, normalizeSpaceObjectOrientation(nextQ));
  };

  const setEulerChannel = (axis: RotationAxis3D, nextDeg: number) => {
    if (!one) return;
    const rx = axis === 'x' ? nextDeg : eulerDeg.x;
    const ry = axis === 'y' ? nextDeg : eulerDeg.y;
    const rz = axis === 'z' ? nextDeg : eulerDeg.z;
    const nextQ = quatFromEulerDegrees(rx, ry, rz);
    ops.object(one.id, normalizeSpaceObjectOrientation(nextQ), `rot-${axis}-${one.id}`);
  };

  const nudgePos = (idx: 0 | 1 | 2, deltaM: number) => {
    if (!one) return;
    const p = [...one.pos] as [number, number, number];
    const next = Number((p[idx] + deltaM).toFixed(3));
    p[idx] = idx === 1 ? Math.max(0, next) : next;
    ops.object(one.id, { pos: p });
  };

  return (
    <aside ref={ref} className={`${s.inspector} ${s.glass}`} aria-label="Thuộc tính" data-testid="study-inspector">
      <header className={s.panelHead} style={{ padding: '10px 14px' }}>
        <div className={s.panelTitle} style={{ fontSize: 15 }}>{one ? item?.name ?? one.kind : oneW ? WIDGET_META[oneW.type].label : selection.includes('character') ? 'Nhân vật' : `${selection.length} mục đã chọn`}</div>
        <button type="button" className={s.iconBtn} onClick={() => useSpace.getState().select([])} aria-label="Bỏ chọn">×</button>
      </header>
      <div className={s.panelBody} style={{ padding: 14 }}>
        {selection.includes('character') && <button type="button" className={`${s.btn} ${s.primary}`} onClick={onCharacter}><Shirt size={14} /> Tùy chỉnh nhân vật</button>}
        {one && oneQuat && (
          <>
            <div className={s.fieldRow} style={{ marginBottom: 10 }}>
              <button
                type="button"
                className={`${s.btn} ${!oneUpright ? s.primary : ''}`}
                style={{ flex: 1 }}
                disabled={oneUpright && one.quat === undefined && !one.state?.tilt}
                onClick={() => ops.object(one.id, resetSpaceObjectUprightPatch(one, oneQuat))}
                aria-label="Dựng đứng lại"
                data-testid="inspector-reset-upright"
              >
                <ArrowUpToLine size={15} />
                {!oneUpright ? `Dựng đứng lại (nghiêng ${oneTiltDeg}°)` : 'Đang đứng thẳng (0°)'}
              </button>
            </div>
            <div className={s.field}>Xoay nhanh ngang (Y) · {Math.round(eulerDeg.y)}°
              <div className={s.fieldRow}>
                <button type="button" className={s.iconBtn} onClick={() => stepAxis('y', -Math.PI / 2)} aria-label="Xoay trái 90°" title="Xoay trái 90°"><RotateCcw size={15} /></button>
                <input className={s.range} style={{ flex: 1 }} type="range" min={0} max={360} step={1} value={Math.round(eulerDeg.y)} onChange={(e) => setEulerChannel('y', Number(e.target.value))} aria-label="Góc xoay" />
                <button type="button" className={s.iconBtn} onClick={() => stepAxis('y', Math.PI / 2)} aria-label="Xoay phải 90°" title="Xoay phải 90°"><RotateCw size={15} /></button>
              </div>
            </div>
            <div className={s.field}>Xoay 3 trục 360° (X · Y · Z)
              <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                {(['x', 'y', 'z'] as const).map((axis) => {
                  const meta = AXIS_META_3D[axis];
                  const val = Math.round(eulerDeg[axis]);
                  return (
                    <div key={axis} style={{ display: 'grid', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5, fontWeight: 700 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color, display: 'inline-block' }} aria-hidden="true" />
                          {meta.code} · {meta.shortVi}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{val}°</span>
                      </div>
                      <div className={s.fieldRow} style={{ gap: 4 }}>
                        <button type="button" className={s.btn} style={{ padding: '2px 7px', fontSize: 11.5 }} onClick={() => stepAxis(axis, -Math.PI / 12)} aria-label={`Giảm góc trục ${meta.code} 15 độ`}>-15°</button>
                        <input
                          className={s.range}
                          style={{ flex: 1, accentColor: meta.color }}
                          type="range"
                          min={0}
                          max={360}
                          step={1}
                          value={val}
                          onChange={(e) => setEulerChannel(axis, Number(e.target.value))}
                          aria-label={meta.vi}
                          data-testid={`inspector-rot-${axis}`}
                        />
                        <button type="button" className={s.btn} style={{ padding: '2px 7px', fontSize: 11.5 }} onClick={() => stepAxis(axis, Math.PI / 12)} aria-label={`Tăng góc trục ${meta.code} 15 độ`}>+15°</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <label className={s.field}>Kích thước {Math.round(one.scale * 100)}%
              <input className={s.range} type="range" min={0.4} max={2.5} step={0.05} value={one.scale} onChange={(e) => ops.object(one.id, { scale: Number(e.target.value) }, `scale-${one.id}`)} />
            </label>
            <div className={s.field}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Độ cao (m) · {one.pos[1].toFixed(2)} m</span>
                {one.pos[1] > 0.005 && (
                  <button type="button" className={s.btn} style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => ops.object(one.id, { pos: [one.pos[0], 0, one.pos[2]] })}>Chạm sàn</button>
                )}
              </span>
              <input className={s.range} type="range" min={0} max={2.9} step={0.01} value={one.pos[1]} aria-label="Độ cao (m)" onChange={(e) => ops.object(one.id, { pos: [one.pos[0], Number(e.target.value), one.pos[2]] }, `y-${one.id}`)} />
            </div>
            <div className={s.field}>Vị trí 3 trục (X · Y · Z)
              <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                {([
                  ['X', 0, '#ff5c6c'],
                  ['Y', 1, '#34d399'],
                  ['Z', 2, '#38bdf8'],
                ] as const).map(([axisLabel, idx, color]) => (
                  <div key={axisLabel} className={s.fieldRow} style={{ gap: 5 }}>
                    <span style={{ width: 22, fontWeight: 800, fontSize: 12, color }}>{axisLabel}</span>
                    <button type="button" className={s.btn} style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => nudgePos(idx, -0.05)} aria-label={`Giảm ${axisLabel} 5 cm`}>-</button>
                    <input
                      className={s.input}
                      style={{ flex: 1, padding: '4px 8px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                      type="number"
                      step={0.05}
                      value={Number(one.pos[idx].toFixed(2))}
                      aria-label={`Tọa độ ${axisLabel}`}
                      data-testid={`inspector-pos-${axisLabel.toLowerCase()}`}
                      onChange={(e) => {
                        const p = [...one.pos] as typeof one.pos;
                        const v = Number(e.target.value) || 0;
                        p[idx] = idx === 1 ? Math.max(0, v) : v;
                        ops.object(one.id, { pos: p }, `pos-${one.id}`);
                      }}
                    />
                    <button type="button" className={s.btn} style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => nudgePos(idx, 0.05)} aria-label={`Tăng ${axisLabel} 5 cm`}>+</button>
                  </div>
                ))}
              </div>
            </div>
            {item?.tint && (
              <label className={s.field}>Màu chính
                <div className={s.fieldRow}><input type="color" value={one.color ?? item.tint} onChange={(e) => ops.object(one.id, { color: e.target.value }, `color-${one.id}`)} />
                  {one.color && <button type="button" className={s.btn} style={{ padding: '3px 8px' }} onClick={() => ops.object(one.id, { color: undefined })}>Màu gốc</button>}</div>
              </label>
            )}
            <label className={s.field}>Khi bấm vào (lúc học)
              <select className={s.select} value={one.action ?? item?.action ?? (item?.anchor ? 'character:sit' : 'none')} onChange={(e) => ops.object(one.id, { action: e.target.value as ActionId })}>
                {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
              </select>
            </label>
            {item?.anchor && <button type="button" className={s.btn} style={{ marginBottom: 10 }} onClick={() => useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, anchor: one.id } }))}>{layout.character.anchor === one.id ? 'Chỗ ngồi quen của nhân vật' : 'Đặt làm chỗ ngồi quen của nhân vật'}</button>}
          </>
        )}
        {objs.length > 1 && anyTilted && (
          <div className={s.fieldRow} style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              onClick={() => ops.objects(objs.map((o) => o.id), (o) => ({ ...o, ...resetSpaceObjectUprightPatch(o) }))}
              data-testid="inspector-reset-upright-multi"
            >
              <ArrowUpToLine size={14} /> Dựng đứng các vật đã chọn
            </button>
          </div>
        )}
        {oneW && (
          <>
            <label className={s.field}>Độ trong {Math.round((oneW.opacity ?? 1) * 100)}%
              <input className={s.range} type="range" min={0.3} max={1} step={0.05} value={oneW.opacity ?? 1} onChange={(e) => ops.widget(oneW.id, { opacity: Number(e.target.value) }, `op-${oneW.id}`)} />
            </label>
            <div className={s.fieldRow} style={{ marginBottom: 10 }}>
              <button type="button" className={s.btn} onClick={() => ops.layer(1)}>Đưa lên trên</button>
              <button type="button" className={s.btn} onClick={() => ops.layer(-1)}>Đưa xuống dưới</button>
            </div>
          </>
        )}
        {(objs.length > 0 || wids.length > 0) && (
          <div className={s.fieldRow}>
            <button type="button" className={s.btn} onClick={() => ops.duplicateSelected()} title="Ctrl+D"><Copy size={14} /> Nhân bản</button>
            <button type="button" className={s.btn} onClick={() => {
              const lock = !(objs[0]?.locked ?? wids[0]?.locked);
              objs.forEach((o) => ops.object(o.id, { locked: lock })); wids.forEach((w) => ops.widget(w.id, { locked: lock }));
            }}>{(objs[0]?.locked ?? wids[0]?.locked) ? <LockOpen size={14} /> : <Lock size={14} />} {(objs[0]?.locked ?? wids[0]?.locked) ? 'Mở khóa' : 'Khóa vị trí'}</button>
            <button type="button" className={s.btn} onClick={() => { objs.forEach((o) => ops.object(o.id, { hidden: true })); wids.forEach((w) => ops.widget(w.id, { hidden: true })); useSpace.getState().select([]); }}><EyeOff size={14} /> Ẩn</button>
            {objs.length > 1 && <button type="button" className={s.btn} onClick={ops.group}><Group size={14} /> Nhóm</button>}
            {objs.some((o) => o.group) && <button type="button" className={s.btn} onClick={ops.ungroup}><Ungroup size={14} /> Bỏ nhóm</button>}
            <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => ops.removeSelected()} title="Delete"><Trash2 size={14} /> Bỏ khỏi không gian</button>
          </div>
        )}
        <p className={s.hint} style={{ marginTop: 10 }}>Bỏ một công cụ khỏi không gian không xóa ghi chú, việc cần làm hay tài liệu của bạn.</p>
      </div>
    </aside>
  );
}
