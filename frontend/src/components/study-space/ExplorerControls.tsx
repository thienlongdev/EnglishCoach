'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Eye, PersonStanding, Armchair, LayoutGrid, MousePointer2, BookOpen, CalendarDays, CircleHelp, DoorOpen, Gamepad2, Monitor, MoveUp, MoveDown, MoveLeft, MoveRight, ArrowUpFromLine, Shirt, X } from 'lucide-react';
import type { ExplorationState, CameraView } from './world/exploration';
import type { InteractionState } from './world/manipulation';
import type { WorldDestination } from '@/lib/study-space/exploration';
import s from './explorer.module.css';
import { embodiedLabels, type EmbodiedAction } from '@/lib/embodiment/actions';
import type { Verb } from '@/lib/study-space/affordances';
import { SHORTCUTS, defaultKeymap, keyLabel, loadKeymap, remap, type Keymap, type Shortcut } from '@/lib/study-space/keymap';
import { CATALOG_BY_ID } from '@/lib/study-space/catalog';
import type { EdgeReveal } from '@/lib/hud/edgeReveal';
import hudStyles from '@/lib/hud/edge.module.css';
import { pointerLight } from '@/lib/ui/pointerLight';
import ActionWheel, { type WheelAction } from './ActionWheel';

interface Props {
  state: ExplorationState;
  interaction: InteractionState | null;
  target: string | null;
  busy: boolean;
  focusOpen: boolean;
  /** The bars' shared reveal (the HUD key, the screen edges, the focus). */
  hud: EdgeReveal;
  /** Changes when the help key is pressed. */
  helpTick?: number;
  quickOpen: boolean;
  onQuick: (open: boolean) => void;
  wheelOpen: boolean;
  onWheelOpen: (open: boolean) => void;
  onWheelChoose: (run: () => void) => void;
  motions: string[];
  onMotion: (name: string) => void;
  onVerb: (verb: Verb) => void;
  onCancel: () => void;
  onWardrobe: () => void;
  onAction: (action: EmbodiedAction) => void;
  onView: (view: CameraView) => void;
  onLock: () => void;
  onInteract: () => void;
  /** The thing in the hand has a real tool behind it (a book's library, a notebook's notes). */
  onOpenHeld?: () => void;
  onStand: () => void;
  onMove: (x: number, y: number, pointerId?: number) => void;
  onPanel: (panel: string) => void;
  onFocus: () => void;
  onTravel: (destination: WorldDestination) => void;
  onTool: (route: string) => void;
  /** What is in the hands (its catalogue kind), for the prompt. */
  heldKind?: string | null;
  /** The physics engine failed to start: one more try. */
  onRetryPhysics?: () => void;
  /** The room has no cleaning things yet: bring them in. */
  onKit?: () => void;
  /** Override locale (Echo Life forces English regardless of global site locale). */
  vi?: boolean;
  /** True when exploring the full Echo Life city/world (uses scene-neutral hint wording). */
  lifeEnabled?: boolean;
  /** Optional override to suppress duplicate Stand Up button when another HUD layer owns seated prompt. */
  suppressStandPrompt?: boolean;
  /** Optional callback notifying parent when the bottom camera/tools dock reveals or hides. */
  onBottomDockChange?: (open: boolean) => void;
}

interface OptionalManipulationHints {
  rotAxis?: string | null;
  canResetUpright?: boolean;
  gizmoActive?: boolean;
}
let mouseLookHintDismissed = false;
const DOOR_NAME: Record<WorldDestination, [string, string]> = { arena: ['Speaking Arena', 'Speaking Arena'], games: ['phòng trò chơi', 'the games room'] };
/** How each tool is worked, in the fewest words. Told while it is new, then the hands know. */
const WORK: Record<string, [string, string]> = {
  'tool.broom': ['Giữ chuột trái và rê chổi để quét', 'Hold the left button and move to sweep'],
  'tool.mop': ['Giữ chuột trái và rê để lau', 'Hold the left button and move to mop'],
  'tool.dustpan': ['Giữ chuột trái trên đống rác để hốt', 'Hold the left button over the heap to scoop'],
  'tool.cloth': ['Giữ chuột trái trên mặt bàn, kính hoặc chỗ ướt', 'Hold the left button on a surface, glass or a wet spot'],
  'tool.duster': ['Giữ chuột trái trên mặt kệ để phủi', 'Hold the left button on a shelf to dust it'],
  'tool.webbrush': ['Giữ chuột trái và quét qua mạng nhện', 'Hold the left button and brush the cobweb'],
};
const SEEN_TOOL = 'ec_study_tool:v1';
const STEP: Record<string, [string, string]> = { stand: ['Đang đứng dậy', 'Getting up'], walk: ['Đang đi tới cửa', 'Walking to the door'], door: ['Đang mở cửa', 'Opening the door'], through: ['Đang đi qua cửa', 'Going through'] };

const ExplorerControls = memo(function ExplorerControls(p: Props) {
  const { locale } = useLanguage(), vi = p.vi ?? (locale === 'vi'), active = p.state.view !== 'overview';
  const i = p.interaction;
  // Full controls reference stays quietly behind "?" / K so the room view opens uncluttered.
  const [help, setHelp] = useState(false);
  const [hintVisible, setHintVisible] = useState(() => !mouseLookHintDismissed);
  const [keys, setKeys] = useState<Keymap>(defaultKeymap);
  const [waiting, setWaiting] = useState<Shortcut | null>(null);
  useEffect(() => { setKeys(loadKeymap()); }, []);
  // The help key opens and closes the same card the "?" does.
  const firstTick = p.helpTick ?? 0;
  const [tickSeen, setTickSeen] = useState(firstTick);
  useEffect(() => { if ((p.helpTick ?? 0) !== tickSeen) { setTickSeen(p.helpTick ?? 0); setHelp(v => !v); } }, [p.helpTick, tickSeen]);
  useEffect(() => {
    if (!waiting) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code !== 'Escape') { const next = remap(keys, waiting, e.code); if (next) setKeys(next); }
      setWaiting(null);
      window.dispatchEvent(new Event('study:keys-changed'));
    };
    window.addEventListener('keydown', on, { capture: true });
    return () => window.removeEventListener('keydown', on, { capture: true });
  }, [waiting, keys]);
  const seated = !!p.state.seated;
  const showStand = seated && !p.suppressStandPrompt;
  const ix = i as (InteractionState & OptionalManipulationHints) | null;
  const rotAxisLabel = ix?.rotAxis ? ix.rotAxis.toUpperCase() : null;
  const key = (id: Shortcut) => <kbd>{keyLabel(keys[id])}</kbd>;
  const label = (a: { vi: string; en: string } | null | undefined) => a ? (vi ? a.vi : a.en) : null;
  const holding = (i?.held.length ?? 0) > 0;
  const journey = i?.journey ?? null;
  const showResumeHint = active && hintVisible && !p.state.locked && !p.state.pointerMode && !p.state.resume && !journey && !i?.reading && !holding && !i?.primary && !i?.target;
  useEffect(() => {
    if (p.state.locked || p.state.pointerMode) {
      mouseLookHintDismissed = true;
      setHintVisible(false);
    }
  }, [p.state.locked, p.state.pointerMode]);
  useEffect(() => {
    if (!showResumeHint) return;
    const timer = window.setTimeout(() => {
      mouseLookHintDismissed = true;
      setHintVisible(false);
    }, 3650);
    return () => clearTimeout(timer);
  }, [showResumeHint]);
  const more = i?.more.filter(a => !a.blocked) ?? [];
  const heldList = i?.heldActs ?? [];
  // A cleaning tool in the hands: the left button is its work, never a place to put it (that is G, Y or its rack).
  const toolCarry = i?.primary?.verb === 'work-tool';
  const push = i?.push ?? null;
  const toolKind = i?.tool?.kind ?? null;
  const [toolSeen, setToolSeen] = useState<Record<string, number>>({});
  useEffect(() => { try { setToolSeen(JSON.parse(localStorage.getItem(SEEN_TOOL) || '{}')); } catch { /* it starts over */ } }, []);
  const pressingNow = !!i?.tool?.pressing;
  useEffect(() => {
    if (!toolKind || !pressingNow) return;
    setToolSeen(seen => { const next = { ...seen, [toolKind]: (seen[toolKind] ?? 0) + 1 }; try { localStorage.setItem(SEEN_TOOL, JSON.stringify(next)); } catch { /* for this visit */ } return next; });
  }, [toolKind, pressingNow]);
  const toolNew = !!toolKind && (toolSeen[toolKind] ?? 0) < 3;
  const nameOf = (kind: string) => { const it = CATALOG_BY_ID[kind]; return it ? (vi ? it.name : it.nameEn) : kind; };
  const heldName = holding ? (p.heldKind ? nameOf(p.heldKind) : (vi ? 'Đang cầm' : 'In hand')) : null;
  const bottomEdge = p.hud.bind('bottom');
  const bottomOpen = Boolean(active && p.hud.shown.bottom && !p.wheelOpen);
  const [sideNear, setSideNear] = useState(false);
  const [sideOver, setSideOver] = useState(false);
  const [sideFocused, setSideFocused] = useState(false);
  const [gesturesOpen, setGesturesOpen] = useState(false);
  const sideHideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active || p.state.locked) {
      setSideNear(false);
      return;
    }
    const clearTimer = () => {
      if (sideHideTimer.current !== undefined) {
        window.clearTimeout(sideHideTimer.current);
        sideHideTimer.current = undefined;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || document.pointerLockElement) return;
      const nearRight = e.clientX >= window.innerWidth - 28 && e.clientY < window.innerHeight - 92;
      if (nearRight) {
        clearTimer();
        setSideNear(true);
      } else if (sideHideTimer.current === undefined) {
        sideHideTimer.current = window.setTimeout(() => {
          sideHideTimer.current = undefined;
          setSideNear(false);
        }, 650);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      clearTimer();
      window.removeEventListener('pointermove', onMove);
    };
  }, [active, p.state.locked]);
  useEffect(() => {
    p.onBottomDockChange?.(bottomOpen);
    if (typeof document === 'undefined') return;
    if (bottomOpen && p.lifeEnabled) {
      document.documentElement.dataset.ecStudyBottomOpen = '1';
    } else {
      delete document.documentElement.dataset.ecStudyBottomOpen;
    }
    return () => {
      delete document.documentElement.dataset.ecStudyBottomOpen;
    };
  }, [bottomOpen, p.lifeEnabled, p.onBottomDockChange]);
  const sideShown = Boolean(p.hud.pinned || holding || sideNear || sideOver || sideFocused || gesturesOpen);
  const freeHands = vi ? 'Đặt vật đang cầm xuống trước' : 'Put down the held object first';
  const wheelActions: WheelAction[] = useMemo(() => {
    const verbs = (entries: NonNullable<typeof i>['more']): WheelAction[] =>
      entries.map(a => ({ id: `verb-${a.verb}`, label: (vi ? a.vi : a.en), disabled: a.blocked, hint: a.hint ? (vi ? a.hint.vi : a.hint.en) : undefined, run: () => p.onVerb(a.verb) }));
    const gestures: WheelAction[] = embodiedLabels.filter(([a]) => !['jump', 'dance'].includes(a)).map(([action, , vn, en]) => ({ id: action, label: vi ? vn : en, disabled: holding && action !== 'inspect', hint: holding && action !== 'inspect' ? freeHands : undefined, run: () => p.onAction(action) }));
    const motionLabels: Record<string, [string, string]> = { SomaCrouchAZ: ['Cúi thấp', 'Crouch'], SomaWalkTurnAZ: ['Bước và xoay', 'Step and turn'] };
    const movement: WheelAction[] = [{ id: 'jump', label: vi ? 'Nhảy' : 'Jump', disabled: seated || holding, hint: seated ? (vi ? 'Đứng dậy trước' : 'Stand up first') : holding ? freeHands : undefined, run: () => p.onAction('jump') },
      ...(seated ? [{ id: 'stand', label: vi ? 'Đứng dậy' : 'Stand up', run: p.onStand }] : []),
      ...p.motions.filter(name => motionLabels[name]).map(name => ({ id: `motion-${name}`, label: motionLabels[name][vi ? 0 : 1], disabled: holding || seated, hint: holding ? freeHands : seated ? (vi ? 'Đứng dậy trước' : 'Stand up first') : undefined, run: () => p.onMotion(name) }))];
    const danceNames: Record<string, [string, string]> = { Twist: ['Điệu twist', 'Twist'], ChickenDance: ['Điệu gà con', 'Chicken dance'] };
    const postureNames: Record<string, [string, string]> = { Kneel: ['Quỳ một gối', 'Kneel'], FloorSit: ['Ngồi xuống sàn', 'Sit on the floor'],
      Prone: ['Nằm sấp', 'Lie face down'], SideLying: ['Nằm nghiêng', 'Lie on one side'] };
    const dances: WheelAction[] = [
      { id: 'dance-simple', label: vi ? 'Nhún nhảy' : 'Bounce', run: () => p.onAction('dance') },
      ...p.motions.filter(name => danceNames[name]).map(name => ({
        id: 'motion-' + name, label: danceNames[name][vi ? 0 : 1], run: () => p.onMotion(name),
      })),
    ].map(action => ({ ...action, disabled: holding || seated || p.busy,
      hint: holding ? freeHands : seated ? (vi ? 'Đứng dậy trước' : 'Stand up first') : undefined }));
    const category = (id: string, vn: string, en: string, children: WheelAction[], empty: string): WheelAction => ({ id, label: vi ? vn : en, children, disabled: !children.length, hint: children.length ? undefined : empty });
    return [
      category('movement', 'Vận động', 'Movement', movement, ''),
      category('postures', 'Tư thế', 'Postures', seated ? [{ id: 'rise', label: vi ? 'Đứng dậy' : 'Get up', run: p.onStand }] : p.motions.filter(name => postureNames[name]).map(name => ({ id: 'motion-' + name, label: postureNames[name][vi ? 0 : 1], disabled: holding || p.busy, hint: holding ? freeHands : undefined, run: () => p.onMotion(name) })), vi ? 'Chưa có tư thế khả dụng' : 'No posture available'),
      category('gestures', 'Cử chỉ', 'Gestures', gestures, ''),
      category('dance', 'Điệu nhảy', 'Dances', dances, ''),
      category('held', 'Trong tay', 'In hand', verbs(heldList), vi ? 'Chưa cầm vật nào' : 'Nothing held'),
      category('nearby', 'Đồ vật', 'Objects', verbs(i?.more ?? []), vi ? 'Nhìn vào vật để tương tác' : 'Look at an object to interact'),
      category('home', 'Căn phòng', 'Room', [{ id: 'wardrobe', label: vi ? 'Tủ đồ' : 'Wardrobe', run: p.onWardrobe }, ...(p.onKit ? [{ id: 'cleaning-kit', label: vi ? 'Đồ dọn dẹp' : 'Cleaning kit', run: p.onKit }] : [])], ''),
      category('study', 'Học tập', 'Study', [{ id: 'focus', label: vi ? 'Tập trung' : 'Focus', run: p.onFocus }, { id: 'reading', label: vi ? 'Thư viện' : 'Reading', run: () => p.onTool('/reading') }, { id: 'planner', label: vi ? 'Kế hoạch' : 'Planner', run: () => p.onPanel('planner') }], ''),
      category('social', 'Cùng nhau', 'Together', [{ id: 'messenger', label: 'Echo Messenger', run: () => p.onPanel('messenger') }, { id: 'shared', label: vi ? 'Học cùng nhau' : 'Study together', run: () => p.onPanel('shared') }, { id: 'arena', label: 'Speaking Arena', run: () => p.onTravel('arena') }], ''),
    ];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vi, holding, seated, p.busy, p.motions, heldList, i?.more, p.onKit, p.onWardrobe, p.onFocus, p.onStand, p.onVerb, p.onAction, p.onMotion, p.onTool, p.onPanel, p.onTravel]);
  // The four views travel with the bottom bar: the top edge belongs to the room's own toolbar.
  const modesNav = <nav className={`${s.modes} ${s.modesDock}`} aria-label={vi ? 'Góc nhìn phòng học' : 'Room camera'} {...pointerLight}>
    {([
      ['overview', LayoutGrid, vi ? 'Toàn cảnh' : 'Overview'],
      ['first', Eye, vi ? 'Góc nhìn thứ nhất' : 'First person'],
      ['third', PersonStanding, vi ? 'Theo nhân vật' : 'Third person'],
      ['desk', Armchair, vi ? 'Vào bàn học' : 'Desk focus'],
    ] as const).map(([view, Icon, name]) => <button key={view} type="button" data-testid={`study-view-${view}`} aria-label={name} title={name} aria-pressed={p.state.view === view} onClick={() => p.onView(view)}><Icon size={18}/><span>{name}</span></button>)}
  </nav>;
  return <>
    {active && <ActionWheel open={p.wheelOpen} onOpen={p.onWheelOpen} actions={wheelActions} binding={keys.actions} vi={vi} onChoose={p.onWheelChoose}/>}
    <div
      className={s.controls}
      data-spatial-owner="study-controls"
      data-life={p.lifeEnabled ? 'true' : undefined}
      data-bottom-open={bottomOpen ? 'true' : undefined}
      data-playing={p.state.locked && active ? 'true' : undefined}
      inert={p.wheelOpen || undefined}
      aria-hidden={p.wheelOpen || undefined}
      hidden={p.wheelOpen}
    >
    {!active && <div {...bottomEdge} className={`${s.bottom} ${bottomEdge.className}`}>{modesNav}</div>}
    {help && <div className={s.helpCard} role="dialog" aria-label={vi ? 'Cách điều khiển' : 'Controls'} data-testid="study-help" {...pointerLight}>
      <div className={s.helpCardHeader}>
        <strong>{vi ? 'Bảng điều khiển và phím tắt' : 'Controls and shortcuts'}</strong>
        <button type="button" onClick={() => setHelp(false)} aria-label={vi ? 'Đóng hướng dẫn' : 'Close controls'}><X size={15}/></button>
      </div>
      <ul>
        <li><kbd>W A S D</kbd>{vi ? 'Đi lại' : 'Walk'}</li>
        <li><kbd>Shift</kbd>{vi ? 'Giữ để chạy' : 'Hold to run'}</li>
        <li><kbd>{vi ? 'Chuột trái' : 'Left'}</kbd>{vi ? 'Cầm, mở, dùng; đang cầm thì bấm lần nữa để đặt xuống' : 'Take, open, use; with something in hand, click again to put it down'}</li>
        <li><kbd>{vi ? 'Chuột phải' : 'Right'}</kbd>{vi ? 'Đẩy, kéo đồ đạc (bấm lần nữa để buông); đồ nặng: bấm liên tục hoặc giữ để dồn sức' : 'Push, pull furniture (click again to let go); heavy things: click fast or hold to put your weight in'}</li>
        <li><kbd>{vi ? 'Chuột giữa' : 'Middle'}</kbd>{vi ? 'Xem kỹ vật đang cầm (chuột phải cũng vậy)' : 'Look closer at what you hold (so does the right button)'}</li>
        <li><kbd>{vi ? 'Lăn chuột' : 'Wheel'}</kbd>{vi ? 'Xoay vật đang cầm; Shift + lăn để đưa xa gần; xoay đồ đang đẩy' : 'Turns what you hold; Shift + wheel holds it nearer or further; turns furniture you push'}</li>
        <li><kbd>Q E</kbd>{vi ? 'Xoay 360° vật đang cầm' : 'Rotate held item 360°'}</li>
        <li><kbd>Z</kbd>{vi ? 'Đổi trục xoay X / Y / Z hoặc dựng vật lên' : 'Cycle X / Y / Z rotation axis or stand item on a side'}</li>
        <li><kbd>R</kbd>{vi ? 'Đặt thẳng vật đang cầm' : 'Reset held item upright'}</li>
        <li><kbd>T</kbd>{vi ? 'Bật hoặc tắt Gizmo xoay 3D' : 'Toggle 3D rotation gizmo'}</li>
        <li><kbd>G</kbd>{vi ? 'Cầm lên, hoặc thả ra' : 'Pick it up, or let go'}</li>
        <li><kbd>Ctrl Z</kbd>{vi ? 'Hoàn tác việc vừa sắp xếp' : 'Undo the last change to the room'}</li>
        <li><kbd>E</kbd>{vi ? 'Giống chuột trái khi tay trống' : 'Same as left with empty hands'}</li>
        <li><kbd>C</kbd>{vi ? 'Giữ để khom người, dùng WASD để đi thấp' : 'Hold to crouch and move with WASD'}</li>
        <li><kbd>Space</kbd>{vi ? 'Nhảy, hoặc đứng dậy khi đang ngồi' : 'Jump, or stand up when seated'}</li>
        <li><kbd>Esc</kbd>{vi ? 'Thả chuột, dừng việc đang đẩy' : 'Release the mouse, stop pushing'}</li>
      </ul>
      <div className={s.keys}>
        {SHORTCUTS.map(c => <button key={c.id} type="button" data-testid={`study-key-${c.id}`} aria-pressed={waiting === c.id} onClick={() => setWaiting(c.id)}><kbd>{waiting === c.id ? '…' : keyLabel(keys[c.id])}</kbd>{vi ? c.vi : c.en}</button>)}
      </div>
      <small>{vi ? 'Bấm vào một dòng rồi nhấn phím mới để đổi.' : 'Click a line, then press its new key.'}</small>
      <button type="button" className={s.helpDoneBtn} onClick={() => setHelp(false)} data-testid="study-help-close">{vi ? 'Đã hiểu' : 'Got it'}</button>
    </div>}
    {active && <>
      <div className={s.reticle} aria-hidden="true" data-target={!!p.target} data-queued={(i?.queued ?? 0) > 0 || undefined}/>
      {journey && <div className={s.journey} role="status" data-testid="study-journey">
        <span>{i?.journeyStep && STEP[i.journeyStep] ? (vi ? STEP[i.journeyStep][0] : STEP[i.journeyStep][1]) : ''} · {vi ? DOOR_NAME[journey][0] : DOOR_NAME[journey][1]}</span>
        <button type="button" data-testid="study-journey-cancel" onClick={p.onCancel}><X size={15}/>{vi ? 'Hủy' : 'Cancel'} {key('cancel')}</button>
      </div>}
      {!journey && (showStand || push || holding || Boolean(p.target)) && (
        <div
          className={s.centerPromptStack}
          data-low={(!push && holding && i?.reading && !i.book) || undefined}
        >
          {showStand && <button className={s.stand} type="button" data-testid="study-stand" onClick={p.onStand}><ArrowUpFromLine size={16}/><span>{vi ? 'Đứng dậy' : 'Stand up'}</span><kbd>Space</kbd></button>}
          {push && <div className={s.prompt} data-testid="study-push" data-moving={push.moving || undefined} data-effort={!push.effortless || undefined} {...pointerLight}>
            <b>{nameOf(push.kind)}</b>
            {!push.effortless && <span className={`${s.line} ${s.need}`}>{vi ? `Cần ${push.need} N để nhích (${push.pulling ? 'kéo' : 'đẩy'})` : `${push.need} N to budge it (${push.pulling ? 'pull' : 'push'})`}</span>}
            {!push.effortless && <span className={s.line}><kbd className={s.mouse} data-button="right" aria-hidden="true"/><kbd>Shift</kbd>{key('effort')}{vi ? '— Bấm liên tục hoặc giữ để dồn sức' : '— Click fast or hold to put your weight in'}</span>}
            <span className={s.line}><kbd>W</kbd><kbd>S</kbd>{vi ? '— Đẩy, kéo' : '— Push, pull'}</span>
            <span className={s.line}><kbd className={s.mouse} data-button="middle" aria-hidden="true"/>{vi ? '— Xoay' : '— Turn'}</span>
            <span className={s.line}><kbd className={s.mouse} data-button={push.effortless ? 'right' : 'left'} aria-hidden="true"/>{vi ? '— Buông ra' : '— Let go'}</span>
            {push.blocked && <span className={`${s.line} ${s.warn}`}>{vi ? 'Đang bị vướng: đổi hướng hoặc buông ra' : 'Stuck: change direction or let go'}</span>}
          </div>}
          {/* The open book's own bar (BookHud) carries its controls; this line is for a book with nothing to show yet. */}
          {!push && holding && i?.reading && !i.book && <div className={`${s.prompt} ${s.promptLow}`} data-testid="study-reading" {...pointerLight}>
            <b>{heldName}{i.bookPage ? ` · ${vi ? 'trang' : 'page'} ${i.bookPage.at}/${i.bookPage.of}` : ''}</b>
            <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>{vi ? '— Trang sau' : '— Next page'}</span>
            <span className={s.line}><kbd className={s.mouse} data-button="right" aria-hidden="true"/>{vi ? '— Trang trước' : '— Previous page'}</span>
            <span className={s.line}><kbd className={s.mouse} data-button="middle" aria-hidden="true"/>{vi ? '— Lật nhanh' : '— Flip through'}</span>
            <span className={s.line}><kbd>H</kbd>{vi ? '— Gấp sách' : '— Close it'}</span>
          </div>}
          {!push && holding && i?.tool && !pressingNow && <div className={s.prompt} data-testid="study-tool" data-kind={i.tool.kind} {...pointerLight}>
            <b>{heldName}</b>
            {i.primary && <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>— {label(i.primary)}</span>}
            {i.secondary && <span className={s.line}><kbd className={s.mouse} data-button="right" aria-hidden="true"/>— {label(i.secondary)}</span>}
            {!i.primary && WORK[i.tool.kind] && <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>— {p.state.locked ? WORK[i.tool.kind][vi ? 0 : 1] : (vi ? WORK[i.tool.kind][0].replace('Giữ chuột trái', 'Bấm để bắt đầu hoặc dừng') : WORK[i.tool.kind][1].replace(/Hold the left button/i, 'Click to start or stop'))}</span>}
            {toolNew && <span className={s.line}>{key('drop')}{vi ? '— Thả' : '— Let go'}</span>}
          </div>}
          {!push && holding && !i?.reading && !i?.tool && <div className={s.prompt} data-testid="study-place" data-ok={i?.place ? String(i.place.ok) : undefined} {...pointerLight}>
            <b>{heldName}</b>
            {i?.place?.ok && !toolCarry && <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>{i.placeShelf ? (vi ? '— Cất lại lên kệ' : '— Put it back on the shelf') : (vi ? '— Đặt xuống' : '— Put it down')}</span>}
            {(!i?.place?.ok || toolCarry) && i?.primary && <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>— {label(i.primary)}</span>}
            {!toolCarry && i?.place && !i.place.ok && i.place.reason && !i?.primary && <span className={`${s.line} ${s.warn}`} role="status">{vi ? i.place.reason.vi : i.place.reason.en}</span>}
            {!toolCarry && !i?.place && !i?.inspecting && <span className={s.line}>{vi ? 'Nhìn vào chỗ muốn đặt' : 'Look where it should go'}</span>}
            {i?.inspecting && <span className={s.line}><kbd className={s.mouse} data-button="left" aria-hidden="true"/>{vi ? '— Thôi xem' : '— Stop looking'}</span>}
            {!i?.inspecting && !i?.primary && <span className={s.line}><kbd className={s.mouse} data-button="middle" aria-hidden="true"/><kbd>Q</kbd><kbd>E</kbd>{vi ? '— Xoay 360°' : '— Rotate 360°'}</span>}
            {!i?.inspecting && (Boolean(rotAxisLabel) || Boolean(i?.canStand) || !toolCarry) && <span className={s.line} data-axis={rotAxisLabel ?? undefined}><kbd>Z</kbd>{rotAxisLabel ? (vi ? `— Trục: ${rotAxisLabel}` : `— Axis: ${rotAxisLabel}`) : i?.canStand ? (vi ? '— Dựng lên (Trục X/Y/Z)' : '— Stand it up (Axis: X/Y/Z)') : (vi ? '— Trục: X/Y/Z' : '— Axis: X/Y/Z')}</span>}
            {!i?.inspecting && !toolCarry && ix?.canResetUpright !== false && <span className={s.line}><kbd>R</kbd>{vi ? '— Đặt thẳng' : '— Upright'}</span>}
            {!i?.inspecting && !toolCarry && <span className={s.line} data-active={ix?.gizmoActive ? 'true' : undefined}><kbd>T</kbd>{ix?.gizmoActive ? (vi ? '— Gizmo 3D: Bật' : '— 3D Gizmo: On') : (vi ? '— Gizmo 3D' : '— 3D Gizmo')}</span>}
            {i?.secondary && <span className={s.line}><kbd className={s.mouse} data-button="right" aria-hidden="true"/>— {label(i.secondary)}</span>}
            <span className={s.line}><kbd>G</kbd>{vi ? '— Thả' : '— Let go'}</span>
          </div>}
          {!push && !holding && p.target && <div className={s.prompt} data-testid="study-prompt" {...pointerLight}>
            <b>{p.target}</b>
            {i?.primary && <button type="button" data-testid="study-interact" data-verb={i.primary.verb} disabled={p.busy || i.primary.blocked} onClick={p.onInteract}><kbd className={s.mouse} data-button="left" aria-label={vi ? 'Chuột trái' : 'Left mouse'}/><kbd>E</kbd><span>— {label(i.primary)}</span></button>}
            {i?.primary?.blocked && i.primary.hint && <span className={`${s.line} ${s.warn}`}>{vi ? i.primary.hint.vi : i.primary.hint.en}</span>}
            {i?.secondary && <button type="button" data-testid="study-secondary" data-verb={i.secondary.verb} disabled={p.busy} onClick={() => p.onVerb(i.secondary!.verb)}><kbd className={s.mouse} data-button="right" aria-label={vi ? 'Chuột phải' : 'Right mouse'}/><span>— {label(i.secondary)}</span></button>}
            {!seated && i?.grab && <button type="button" data-testid="study-grab-target" data-verb={i.grab.verb} disabled={p.busy} onClick={() => p.onVerb(i.grab!.verb)}><kbd>G</kbd><span>— {label(i.grab)}</span></button>}
          </div>}
        </div>
      )}
      {showResumeHint && (
        <div className={s.resumeHint} data-testid="study-resume-hint">
          {vi && !p.lifeEnabled ? 'Bấm vào phòng để nhìn bằng chuột · Esc để thả chuột' : 'Click scene to look · Esc releases'}
        </div>
      )}
      {i?.physics === 'loading' && i.mode === 'busy' && <div className={s.physics} role="status" data-testid="study-physics">{vi ? 'Đang chuẩn bị tương tác vật lý…' : 'Getting physics ready…'}</div>}
      {i?.physics === 'failed' && <div className={s.physics} role="alert" data-testid="study-physics" data-failed="true">{vi ? 'Chưa tải được tương tác vật lý.' : 'Physics could not start.'}{p.onRetryPhysics && <button type="button" onClick={p.onRetryPhysics} data-testid="study-physics-retry">{vi ? 'Thử lại' : 'Retry'}</button>}</div>}
      <div
        className={s.expressions}
        data-side-hidden={!sideShown ? 'true' : undefined}
        onPointerEnter={() => setSideOver(true)}
        onPointerLeave={() => setSideOver(false)}
        onFocusCapture={() => setSideFocused(true)}
        onBlurCapture={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSideFocused(false);
        }}
      >
        {holding && <div className={s.held} data-testid="study-held">
          {i?.placing && <button type="button" data-testid="study-grab" onClick={()=>p.onAction('grab')}><kbd>G</kbd>{vi?'Đặt xuống chỗ đang nhìn':'Put it where you look'}</button>}
          {!i?.placing && <button type="button" data-testid="study-grab" onClick={()=>p.onAction('grab')}><kbd>G</kbd>{vi?'Thả xuống':'Let go'}</button>}
          {heldList.filter(a => !['drop', 'throw'].includes(a.verb)).map(a => <button key={a.verb} type="button" data-testid={`study-held-${a.verb}`} aria-pressed={a.verb === 'inspect' ? !!i?.inspecting : undefined} onClick={() => p.onVerb(a.verb)}>{a.verb === 'inspect' ? <kbd>H</kbd> : a.verb === 'carry-tool' ? null : key('use-held')}{label(a)}</button>)}
          {p.onOpenHeld && <button type="button" data-testid="study-open-held" onClick={p.onOpenHeld}>{vi?'Mở trong ứng dụng':'Open it for real'}</button>}
          {!toolCarry && !i?.reading && !i?.tool && (Boolean(rotAxisLabel) || Boolean(ix?.gizmoActive) || Boolean(ix?.canResetUpright)) && (
            <div className={s.heldMeta}>
              {rotAxisLabel && <span><kbd>Z</kbd> {vi ? `Trục ${rotAxisLabel}` : `Axis: ${rotAxisLabel}`}</span>}
              {ix?.canResetUpright && <span><kbd>R</kbd> {vi ? 'Đặt thẳng' : 'Upright'}</span>}
              {ix?.gizmoActive !== undefined && <span><kbd>T</kbd> {ix.gizmoActive ? (vi ? 'Gizmo bật' : '3D Gizmo On') : '3D Gizmo'}</span>}
            </div>
          )}
        </div>}
        {<details onToggle={e => setGesturesOpen((e.currentTarget as HTMLDetailsElement).open)}><summary>{vi?'Cử chỉ':'Gestures'}</summary><div>{embodiedLabels.filter(([action])=>!seated||action!=='jump').map(([action,k,vn,en])=><button type="button" key={action} data-testid={`study-action-${action}`} onClick={()=>p.onAction(action)}><kbd>{k}</kbd>{vi?vn:en}</button>)}</div></details>}
      </div>
      {p.quickOpen && <div className={s.quick} role="menu" aria-label={vi ? 'Thao tác nhanh' : 'Quick actions'} data-testid="study-quick" {...pointerLight}>
        <b>{p.target ?? (vi ? 'Thao tác nhanh' : 'Quick actions')}</b>
        {more.map(a => <button key={a.verb + a.vi} type="button" role="menuitem" data-verb={a.verb} onClick={() => p.onVerb(a.verb)}>{label(a)}</button>)}
        {heldList.map(a => <button key={'h' + a.verb} type="button" role="menuitem" data-verb={a.verb} onClick={() => p.onVerb(a.verb)}>{label(a)}</button>)}
        {p.onKit && <button type="button" role="menuitem" data-testid="study-kit" onClick={() => { p.onQuick(false); p.onKit?.(); }}>{vi ? 'Mang đồ dọn dẹp vào phòng' : 'Bring in the cleaning things'}</button>}
        <button type="button" role="menuitem" onClick={() => { p.onQuick(false); p.onWardrobe(); }}><Shirt size={15}/>{vi ? 'Tủ đồ' : 'Wardrobe'}</button>
        <button type="button" role="menuitem" onClick={() => { p.onQuick(false); p.onTravel('arena'); }}><DoorOpen size={15}/>Speaking Arena</button>
        <button type="button" role="menuitem" onClick={() => { p.onQuick(false); p.onTravel('games'); }}><Gamepad2 size={15}/>{vi ? 'Trò chơi' : 'Games'}</button>
      </div>}
      <div {...bottomEdge} className={`${s.bottom} ${bottomEdge.className}`}>
        {modesNav}
        <div className={s.tools} aria-label={vi ? 'Công cụ học và lối đi' : 'Study tools and destinations'} {...pointerLight}>
          <button type="button" onClick={()=>p.onWheelOpen(true)} aria-haspopup="dialog" aria-expanded={p.wheelOpen} data-testid="study-wheel-open"><PersonStanding size={18}/>{vi?'Hoạt động':'Actions'}{key('actions')}</button>
          <button type="button" onClick={p.onFocus} aria-pressed={p.focusOpen} data-testid="study-focus"><Monitor size={18}/>{vi ? 'Tập trung' : 'Focus'}{key('focus')}</button>
          <button type="button" className={s.mouseToggle} onClick={p.onLock} aria-pressed={p.state.locked} data-testid="study-mouse" data-resume={p.state.resume || undefined} title={p.state.locked ? (vi ? 'Esc để thả chuột' : 'Esc releases the mouse') : (vi ? 'Bấm để nhìn bằng chuột' : 'Click for mouse look')}><MousePointer2 size={18}/><span>{p.state.resume ? (vi ? 'Bấm để nhìn tiếp' : 'Click to resume') : p.state.locked ? (vi ? 'Esc để thả chuột' : 'Esc to release') : (vi ? 'Nhìn bằng chuột' : 'Mouse look')}</span></button>
          <button type="button" onClick={() => p.onView(p.state.view === 'third' ? 'first' : 'third')} data-testid="study-camera-toggle"><Eye size={18}/>{vi ? 'Góc nhìn' : 'Camera'}{key('camera')}</button>
          <button type="button" onClick={p.onWardrobe} data-testid="study-wardrobe"><Shirt size={18}/>{vi ? 'Tủ đồ' : 'Wardrobe'}{key('wardrobe')}</button>
          <span className={s.toolsRule} aria-hidden="true"/>
          <button type="button" onClick={() => p.onPanel('planner')}><CalendarDays size={18}/>{vi ? 'Kế hoạch' : 'Planner'}{key('planner')}</button>
          <button type="button" onClick={() => p.onTool('/reading')}><BookOpen size={18}/>{vi ? 'Thư viện' : 'Reading'}</button>
          <button type="button" onClick={() => p.onTravel('arena')} disabled={p.busy || !!journey} data-testid="study-travel-arena" data-morph-source="study-arena"><DoorOpen size={18}/>Speaking Arena{key('arena')}</button>
          <button type="button" onClick={() => p.onTravel('games')} disabled={p.busy || !!journey} data-testid="study-travel-games" data-morph-source="study-games"><Gamepad2 size={18}/>{vi ? 'Trò chơi' : 'Games'}{key('games')}</button>
          <span className={s.toolsRule} aria-hidden="true"/>
          <button type="button" onClick={() => setHelp(!help)} aria-pressed={help} aria-label={vi ? 'Cách điều khiển' : 'Controls'} title={vi ? 'Cách điều khiển' : 'Controls'} data-testid="study-help-toggle"><CircleHelp size={18}/>{key('help')}</button>
        </div>
      </div>
      {p.hud.hint && !p.hud.shown.bottom && <div className={hudStyles.hint} role="status" data-testid="hud-hint">{vi ? <>Đưa chuột xuống mép dưới hoặc nhấn {key('hud')} để hiện thanh công cụ</> : <>Move to the bottom edge or press {key('hud')} for the toolbar</>}</div>}
      {!seated && <div className={s.touch} aria-label={vi ? 'Di chuyển cảm ứng' : 'Touch movement'}>
        {([[0,1,MoveUp,vi?'Tiến':'Forward'],[-1,0,MoveLeft,vi?'Sang trái':'Left'],[0,-1,MoveDown,vi?'Lùi':'Back'],[1,0,MoveRight,vi?'Sang phải':'Right']] as const).map(([x,y,Icon,name]) => <button key={name} type="button" aria-label={name} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); p.onMove(x,y,e.pointerId); }} onPointerUp={e => p.onMove(0,0,e.pointerId)} onPointerCancel={e => p.onMove(0,0,e.pointerId)} onLostPointerCapture={e => p.onMove(0,0,e.pointerId)} onKeyDown={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();p.onMove(x,y);}}} onKeyUp={()=>p.onMove(0,0)} onBlur={()=>p.onMove(0,0)}><Icon size={21}/></button>)}
      </div>}
    </>}
    </div>
  </>;
});

export default ExplorerControls;
