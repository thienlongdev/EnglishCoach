'use client';
/**
 * Echo Life Wave 11 — Visual inZOI-Style Build Studio.
 * Bottom-docked Build Catalog bar (~248px tall) + top-center Build Toolbar
 * leaving the entire upper 3D room unobstructed.
 * 5 tabs: Furniture, Finishes and Fabrics, Room Styles (with 4 one-click presets),
 * Upgrades and Parts, and Properties (all 6 residences).
 * 100% clean English copy, pure multi-stop Pearl Opal glass over WebGL, zero V3 edits.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Camera,
  Cpu,
  Grid,
  Hammer,
  Home,
  Palette,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
  X,
} from 'lucide-react';
import {
  CATALOG,
  MATERIAL_FINISHES,
  type V3OwnedObject,
} from '@/lib/echo-life/v3/game-core/index.mjs';
import { computePcStats } from '@/lib/echo-life/v3/progression/pc-builder.mjs';
import { getOwnedDrivableCars } from '@/lib/echo-life/v3/vehicles/car.mjs';
import { PATTERN_CATALOG, type PatternId } from '@/lib/avatar/characterCreator';
import { cleanDisplayCopy } from '@/lib/echo-life/game/session';
import type { WorkshopAction } from '@/lib/echo-life/game/saver';
import type { EchoLifeGameHost } from '../world/echoLife/gameHost';
import { propertyList } from '../world/echoLife/workshopView';
import s from './buildStudio.module.css';

export type BuildStudioTab =
  | 'furniture'
  | 'finishes'
  | 'rooms'
  | 'upgrades'
  | 'properties';

export interface BuildRoomPreset {
  readonly id: string;
  readonly name: string;
  readonly styleId: string;
  readonly finishId: string;
  readonly accentColor: string;
  readonly summary: string;
}

export interface BuildStudioProps {
  open: boolean;
  host: EchoLifeGameHost | null;
  initialItemId?: string;
  topDownCamera?: boolean;
  gridSnapMeters?: 0 | 0.25 | 0.5;
  placementValid?: boolean | null;
  activePlacingLabel?: string | null;
  onToggleTopDownCamera?: () => void;
  onCycleGridSnap?: (next: 0 | 0.25 | 0.5) => void;
  onRotateBuild?: (deltaDeg: number) => void;
  onApplyCustomTint?: (instanceId: string, colorHex: string, patternId: PatternId) => void;
  onApplyRoomPreset?: (preset: BuildRoomPreset, roomZone: string) => void;
  onClose: () => void;
}

interface CatalogPart {
  id: string;
  name: string;
  price: number;
  slot?: string;
  appliesTo?: string[];
}

const CATALOG_UPGRADES = CATALOG.upgrades as {
  id: string;
  sourceVariant: string;
  targetVariant: string;
  creditsCost: number;
}[];

const CATALOG_PC = CATALOG.pc as Record<string, CatalogPart[]>;
const CATALOG_VEHICLE_PARTS = (CATALOG.vehicles as { components: CatalogPart[] }).components;
const CATALOG_HOMES = CATALOG.properties as {
  roomTypes: string[];
  properties: { id: string; unlockedRooms: string[] }[];
  roomStyleFamilies: Record<
    string,
    { id: string; name: string; unlockCost: number; wallColor?: string; floorColor?: string }
  >;
};

const PC_SLOTS: Record<string, string> = {
  monitors: 'monitors',
  desks: 'desk',
  cases: 'case',
  gpus: 'gpu',
  cpus: 'cpu',
  ram: 'ram',
  storage: 'storage',
  motherboards: 'motherboard',
  cooling: 'cooling',
  fans: 'fans',
  rgb: 'rgb',
  keyboards: 'keyboard',
  mice: 'mouse',
  speakers: 'speakers',
  microphones: 'microphone',
  accessories: 'accessories',
};

const FINISH_SWATCHES: Record<string, [string, string]> = {
  natural_oak: ['#cfa678', '#ede1cf'],
  walnut_brass: ['#593825', '#d4a656'],
  nordic_birch: ['#e8dcc8', '#cbd5e1'],
  matte_graphite: ['#333942', '#64748b'],
  terracotta_linen: ['#c76c52', '#f1e5d6'],
  emerald_velvet: ['#1f6e59', '#94d3bc'],
  royal_ivory_gilt: ['#f3ece0', '#d9ad54'],
};

const CUSTOM_TINT_SWATCHES = [
  '#f2efe9', '#d8c7a8', '#b39572', '#6f5d52', '#3f6152', '#2f3a55', '#9c3e49', '#2b2b30',
] as const;

export const ROOM_PRESETS: readonly BuildRoomPreset[] = [
  {
    id: 'preset_riverside_oak',
    name: 'Riverside Warm Oak',
    styleId: 'cozy',
    finishId: 'natural_oak',
    accentColor: '#cfa678',
    summary: 'Sunlit oak timber paired with calm lantern-street warmth.',
  },
  {
    id: 'preset_nordic_study',
    name: 'Nordic Study Minimal',
    styleId: 'minimalist',
    finishId: 'nordic_birch',
    accentColor: '#e8dcc8',
    summary: 'Clean pale birch surfaces tailored for quiet study clarity.',
  },
  {
    id: 'preset_botanical_emerald',
    name: 'Botanical Emerald Lounge',
    styleId: 'modern',
    finishId: 'emerald_velvet',
    accentColor: '#1f6e59',
    summary: 'Rich botanical green upholstery with contemporary crisp framing.',
  },
  {
    id: 'preset_grand_atelier',
    name: 'Grand Ivory Atelier',
    styleId: 'royal',
    finishId: 'royal_ivory_gilt',
    accentColor: '#d9ad54',
    summary: 'Refined ivory gallery palette accented with warm gilt brass.',
  },
] as const;

const BUILD_TABS: readonly { id: BuildStudioTab; label: string; Icon: typeof Hammer }[] = [
  { id: 'furniture', label: 'Furniture', Icon: Hammer },
  { id: 'finishes', label: 'Finishes and Fabrics', Icon: Palette },
  { id: 'rooms', label: 'Room Styles', Icon: Home },
  { id: 'upgrades', label: 'Upgrades and Parts', Icon: Cpu },
  { id: 'properties', label: 'Properties', Icon: Building2 },
];

type FurnitureCategoryFilter = 'all' | 'living' | 'electronics' | 'vehicles' | 'storage';

function itemDisplayName(obj: V3OwnedObject): string {
  return cleanDisplayCopy(obj.selectedVariantId.replaceAll('_', ' '));
}

export function BuildStudio({
  open,
  host,
  initialItemId = '',
  topDownCamera = false,
  gridSnapMeters = 0.25,
  placementValid = null,
  activePlacingLabel = null,
  onToggleTopDownCamera,
  onCycleGridSnap,
  onRotateBuild,
  onApplyCustomTint,
  onApplyRoomPreset,
  onClose,
}: BuildStudioProps) {
  const [tab, setTab] = useState<BuildStudioTab>('furniture');
  const [categoryFilter, setCategoryFilter] = useState<FurnitureCategoryFilter>('all');
  const [selectedId, setSelectedId] = useState(initialItemId);
  const [selectedRoom, setSelectedRoom] = useState('living');
  const [customTint, setCustomTint] = useState('#d8c7a8');
  const [customPattern, setCustomPattern] = useState<PatternId>('solid');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const game = host?.game ?? null;
  const objects = game?.s.progression.ownedObjects ?? [];

  useEffect(() => {
    if (open && initialItemId) setSelectedId(initialItemId);
  }, [open, initialItemId]);

  const selectedItem = useMemo(
    () => objects.find(o => o.instanceId === selectedId) ?? objects[0] ?? null,
    [objects, selectedId],
  );

  const perform = useCallback(
    async (action: WorkshopAction) => {
      if (!host?.saverNow || !game || busy) return;
      setBusy(true);
      try {
        const res = await host.saverNow.configure(action);
        setStatusMsg(cleanDisplayCopy(res.msg));
        if (res.ok) game.workshopEvent(action.type);
      } finally {
        setBusy(false);
      }
    },
    [host, game, busy],
  );

  const nextGridSnap = useCallback(() => {
    const next: 0 | 0.25 | 0.5 =
      gridSnapMeters === 0.25 ? 0.5 : gridSnapMeters === 0.5 ? 0 : 0.25;
    onCycleGridSnap?.(next);
  }, [gridSnapMeters, onCycleGridSnap]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (e.key === 'q' || e.key === 'Q' || e.key === '[') {
        e.preventDefault();
        onRotateBuild?.(-45);
      } else if (e.key === 'e' || e.key === 'E' || e.key === ']') {
        e.preventDefault();
        onRotateBuild?.(45);
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        nextGridSnap();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        onToggleTopDownCamera?.();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, onRotateBuild, nextGridSnap, onToggleTopDownCamera]);

  if (!open) return null;

  const undoStack = game?.s.progression.undoStack;
  const redoStack = game?.s.progression.redoStack;
  const canUndo = Array.isArray(undoStack) && undoStack.length > 0;
  const canRedo = Array.isArray(redoStack) && redoStack.length > 0;

  const activePropertyId = game?.s.progression.properties.activePropertyId ?? propertyList[0]?.id ?? '';
  const ownedPropertyIds = (game?.s.progression.properties.ownedIds as string[] | undefined) ?? [];
  const availableRooms =
    CATALOG_HOMES.properties
      .find(p => p.id === activePropertyId)
      ?.unlockedRooms.filter(z => CATALOG_HOMES.roomTypes.includes(z)) ?? ['living', 'bedroom', 'kitchen'];
  const currentRoom = availableRooms.includes(selectedRoom) ? selectedRoom : availableRooms[0];
  const roomStyles = (game?.s.progression.roomStyles as Record<string, string> | undefined) ?? {};
  const unlockedStyles = (game?.s.progression.unlockedStyles as string[] | undefined) ?? [];
  const drivableCars = game ? getOwnedDrivableCars(game.s) : [];

  const filteredFurniture = objects.filter(o => {
    if (categoryFilter === 'all') return true;
    if (categoryFilter === 'storage') return Boolean(o.location.inStorage);
    if (categoryFilter === 'vehicles') return o.category.startsWith('vehicle');
    if (categoryFilter === 'electronics') return o.category.includes('electronics');
    return !o.category.startsWith('vehicle') && !o.category.includes('electronics');
  });

  const selectedUpgrades = selectedItem
    ? CATALOG_UPGRADES.filter(u => u.sourceVariant === selectedItem.selectedVariantId)
    : [];

  const selectedParts: CatalogPart[] = selectedItem
    ? selectedItem.category === 'electronics_pc'
      ? Object.entries(PC_SLOTS).flatMap(([group, slot]) =>
          (CATALOG_PC[group] ?? []).map(part => ({ ...part, slot })),
        )
      : selectedItem.category.startsWith('vehicle')
        ? CATALOG_VEHICLE_PARTS.filter(p =>
            p.appliesTo?.includes(String(selectedItem.interactionState.vehicleClass)),
          )
        : []
    : [];

  const handleApplyRoomPreset = async (preset: BuildRoomPreset) => {
    onApplyRoomPreset?.(preset, currentRoom);
    if (game && currentRoom) {
      await perform({ type: 'apply_room_style', zoneId: currentRoom, styleId: preset.styleId });
      if (selectedItem && !selectedItem.category.startsWith('vehicle')) {
        await perform({
          type: 'customize_material',
          instanceId: selectedItem.instanceId,
          finishId: preset.finishId,
        });
      }
    }
    setStatusMsg(`Applied ${preset.name} to ${game?.zoneName(currentRoom) ?? currentRoom}.`);
  };

  return (
    <div
      className={s.buildRoot}
      role="dialog"
      aria-label="Build Studio"
      data-testid="build-studio"
    >
      {/* Top-Center Build Toolbar */}
      <header className={s.topToolbar} data-testid="build-studio-toolbar">
        <button
          type="button"
          className={s.toolBtn}
          aria-pressed={topDownCamera}
          data-testid="build-topdown-btn"
          onClick={() => onToggleTopDownCamera?.()}
        >
          <Camera size={14} aria-hidden="true" />
          <span>Top-Down Camera</span>
        </button>

        <button
          type="button"
          className={s.toolBtn}
          aria-pressed={gridSnapMeters > 0}
          data-testid="build-gridsnap-btn"
          onClick={nextGridSnap}
        >
          <Grid size={14} aria-hidden="true" />
          <span>{gridSnapMeters === 0 ? 'Free Placement' : `Grid Snap ${gridSnapMeters}m`}</span>
        </button>

        <button
          type="button"
          className={s.toolBtn}
          aria-label="Rotate furniture left"
          data-testid="build-rotate-left"
          onClick={() => onRotateBuild?.(-45)}
        >
          <RotateCcw size={14} aria-hidden="true" />
          <span>Rotate Left</span>
        </button>

        <button
          type="button"
          className={s.toolBtn}
          aria-label="Rotate furniture right"
          data-testid="build-rotate-right"
          onClick={() => onRotateBuild?.(45)}
        >
          <RotateCw size={14} aria-hidden="true" />
          <span>Rotate Right</span>
        </button>

        <button
          type="button"
          className={s.toolBtn}
          aria-label="Undo build change"
          disabled={busy || !canUndo}
          data-testid="build-undo-btn"
          onClick={() => void perform({ type: 'undo_build' })}
        >
          <Undo2 size={14} aria-hidden="true" />
          <span>Undo</span>
        </button>

        <button
          type="button"
          className={s.toolBtn}
          aria-label="Redo build change"
          disabled={busy || !canRedo}
          data-testid="build-redo-btn"
          onClick={() => void perform({ type: 'redo_build' })}
        >
          <Redo2 size={14} aria-hidden="true" />
          <span>Redo</span>
        </button>

        {placementValid !== null && (
          <span
            className={`${s.snapBadge} ${placementValid ? s.snapValid : s.snapBlocked}`}
            data-testid="build-snap-validity"
          >
            {activePlacingLabel ? `${activePlacingLabel}: ` : ''}
            {placementValid ? 'Valid Snap' : 'Blocked'}
          </span>
        )}

        <button
          type="button"
          className={s.exitBtn}
          data-testid="build-exit-btn"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
          <span>Exit Build Mode</span>
        </button>
      </header>

      {/* Bottom-Docked Build Catalog Bar */}
      <section className={s.catalogDock} aria-label="Build Catalog" data-testid="build-studio-catalog">
        <div className={s.catalogHead}>
          <div className={s.tabRow} role="tablist" aria-label="Build Studio categories">
            {BUILD_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={s.tabBtn}
                aria-selected={tab === id}
                data-testid={`build-tab-${id}`}
                onClick={() => setTab(id)}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <span className={s.statusReadout} role="status">
            {statusMsg || (selectedItem ? `Selected: ${itemDisplayName(selectedItem)}` : 'Choose an item to customize')}
          </span>
        </div>

        <div className={s.catalogBody}>
          {/* ── TAB 1: FURNITURE ───────────────────────────────────────────────────────────────────────── */}
          {tab === 'furniture' && (
            <>
              <div className={s.filterBar} role="group" aria-label="Furniture filter">
                {(
                  [
                    ['all', 'All Owned'],
                    ['living', 'Rooms and Decor'],
                    ['electronics', 'Electronics and PC'],
                    ['vehicles', 'Vehicles'],
                    ['storage', 'In Storage'],
                  ] as const
                ).map(([fid, flabel]) => (
                  <button
                    key={fid}
                    type="button"
                    className={s.filterChip}
                    aria-pressed={categoryFilter === fid}
                    onClick={() => setCategoryFilter(fid)}
                  >
                    {flabel}
                  </button>
                ))}
              </div>

              <div className={s.cardRail} data-testid="build-furniture-rail">
                {filteredFurniture.length === 0 ? (
                  <div className={s.itemCard}>
                    <strong>No items in this view</strong>
                    <p className={s.cardSub}>Visit Riverside Living or Volt and Silicon along Market Boulevard to expand your catalog.</p>
                  </div>
                ) : (
                  filteredFurniture.map(item => {
                    const isSelected = selectedItem?.instanceId === item.instanceId;
                    const isStarter = !item.instanceId.startsWith('ec_');
                    const isVehicle = item.category.startsWith('vehicle');
                    const isDrivableCar = drivableCars.includes(item);
                    const locLabel = item.location.inStorage
                      ? 'In Storage'
                      : game?.zoneName(item.location.zoneId ?? '') ?? 'Placed';

                    return (
                      <div
                        key={item.instanceId}
                        className={s.itemCard}
                        data-selected={isSelected ? 'true' : 'false'}
                        data-testid={`build-item-${item.instanceId}`}
                        onClick={() => setSelectedId(item.instanceId)}
                      >
                        <div>
                          <div className={s.cardTop}>
                            <strong>{itemDisplayName(item)}</strong>
                            <span className={`${s.badge} ${item.location.inStorage ? s.badgeGold : s.badgeGood}`}>
                              {locLabel}
                            </span>
                          </div>
                          <p className={s.cardSub}>
                            {isStarter ? 'Starter fixture' : 'Owned furniture'} · {item.category.replace(/_/g, ' ')}
                          </p>
                        </div>

                        <div className={s.cardActions}>
                          {!isVehicle && (
                            <button
                              type="button"
                              className={`${s.cardBtn} ${s.cardBtnPrimary}`}
                              onClick={e => {
                                e.stopPropagation();
                                setSelectedId(item.instanceId);
                                host?.beginBuild(item.instanceId);
                              }}
                            >
                              {isStarter ? 'Relocate Starter' : 'Place'}
                            </button>
                          )}
                          {!isVehicle && !isStarter && !item.location.inStorage && (
                            <button
                              type="button"
                              className={s.cardBtn}
                              disabled={busy}
                              onClick={e => {
                                e.stopPropagation();
                                void perform({ type: 'store_object', instanceId: item.instanceId });
                              }}
                            >
                              Store
                            </button>
                          )}
                          {isDrivableCar && game && (
                            <button
                              type="button"
                              className={s.cardBtn}
                              disabled={busy || game.car.spec?.instanceId === item.instanceId}
                              onClick={e => {
                                e.stopPropagation();
                                void perform({ type: 'select_vehicle', instanceId: item.instanceId });
                              }}
                            >
                              {game.car.spec?.instanceId === item.instanceId ? 'Active Car' : 'Select Car'}
                            </button>
                          )}
                          {item.category === 'vehicle_rideable' && game && (
                            <button
                              type="button"
                              className={s.cardBtn}
                              disabled={busy || item.instanceId === game.s.progression.activeVehicleId}
                              onClick={e => {
                                e.stopPropagation();
                                void perform({ type: 'select_vehicle', instanceId: item.instanceId });
                              }}
                            >
                              {item.instanceId === game.s.progression.activeVehicleId ? 'Active Ride' : 'Select Ride'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}

          {/* ── TAB 2: FINISHES AND FABRICS ────────────────────────────────────────────────────────────── */}
          {tab === 'finishes' && (
            <>
              <div className={s.filterBar}>
                <span className={s.badge}>
                  Target: {selectedItem ? itemDisplayName(selectedItem) : 'Select furniture first'}
                </span>
                {PATTERN_CATALOG.map(pat => (
                  <button
                    key={pat.id}
                    type="button"
                    className={s.filterChip}
                    aria-pressed={customPattern === pat.id}
                    onClick={() => {
                      setCustomPattern(pat.id);
                      if (selectedItem) onApplyCustomTint?.(selectedItem.instanceId, customTint, pat.id);
                    }}
                  >
                    {pat.label}
                  </button>
                ))}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 12, fontWeight: 700 }}>
                  <span>Accent Tint</span>
                  <input
                    type="color"
                    value={customTint}
                    aria-label="Custom furniture accent color"
                    onChange={e => {
                      setCustomTint(e.target.value);
                      if (selectedItem) onApplyCustomTint?.(selectedItem.instanceId, e.target.value, customPattern);
                    }}
                  />
                </label>
              </div>

              <div className={s.cardRail} data-testid="build-finishes-rail">
                {Object.values(MATERIAL_FINISHES).map(fin => {
                  const [c1, c2] = FINISH_SWATCHES[fin.id] ?? ['#94a3b8', '#e2e8f0'];
                  const activeFin =
                    (selectedItem?.customAppearance as { finishId?: string } | undefined)?.finishId === fin.id;
                  return (
                    <div
                      key={fin.id}
                      className={s.itemCard}
                      data-selected={activeFin ? 'true' : 'false'}
                      data-testid={`build-finish-${fin.id}`}
                    >
                      <div className={s.cardTop}>
                        <strong>{cleanDisplayCopy(fin.name)}</strong>
                        {activeFin && <span className={`${s.badge} ${s.badgeGood}`}>Applied</span>}
                      </div>
                      <div className={s.swatchDuo}>
                        <span className={s.swatchCircle} style={{ backgroundColor: c1 }} />
                        <span className={s.swatchCircle} style={{ backgroundColor: c2 }} />
                        {CUSTOM_TINT_SWATCHES.slice(0, 3).map(hex => (
                          <button
                            key={`${fin.id}_${hex}`}
                            type="button"
                            className={s.swatchCircle}
                            style={{ width: 18, height: 18, backgroundColor: hex }}
                            aria-label={`Apply custom tint ${hex}`}
                            onClick={() => {
                              setCustomTint(hex);
                              if (selectedItem) onApplyCustomTint?.(selectedItem.instanceId, hex, customPattern);
                            }}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className={`${s.cardBtn} ${activeFin ? '' : s.cardBtnPrimary}`}
                        disabled={busy || !selectedItem || selectedItem.category.startsWith('vehicle') || activeFin}
                        onClick={() =>
                          selectedItem &&
                          void perform({
                            type: 'customize_material',
                            instanceId: selectedItem.instanceId,
                            finishId: fin.id,
                          })
                        }
                      >
                        {activeFin ? 'Current Finish' : 'Apply Finish'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── TAB 3: ROOM STYLES AND 4 ONE-CLICK PRESETS ─────────────────────────────────────────────── */}
          {tab === 'rooms' && (
            <>
              <div className={s.filterBar} role="group" aria-label="Target room">
                {availableRooms.map(roomId => (
                  <button
                    key={roomId}
                    type="button"
                    className={s.filterChip}
                    aria-pressed={currentRoom === roomId}
                    onClick={() => setSelectedRoom(roomId)}
                  >
                    {game?.zoneName(roomId) ?? roomId}
                  </button>
                ))}
              </div>

              <div className={s.cardRail} data-testid="build-rooms-rail">
                {/* 4 One-Click Room Presets */}
                {ROOM_PRESETS.map(preset => (
                  <div key={preset.id} className={s.itemCard} data-testid={`build-preset-${preset.id}`}>
                    <div className={s.cardTop}>
                      <strong>{preset.name}</strong>
                      <span className={`${s.badge} ${s.badgeGold}`}>Preset</span>
                    </div>
                    <p className={s.cardSub}>{preset.summary}</p>
                    <button
                      type="button"
                      className={`${s.cardBtn} ${s.cardBtnPrimary}`}
                      disabled={busy}
                      onClick={() => void handleApplyRoomPreset(preset)}
                    >
                      Apply Preset
                    </button>
                  </div>
                ))}

                {/* All Room Style Families */}
                {Object.values(CATALOG_HOMES.roomStyleFamilies).map(st => {
                  const isCurrent = roomStyles[currentRoom] === st.id;
                  const unlocked = unlockedStyles.includes(st.id);
                  return (
                    <div
                      key={st.id}
                      className={s.itemCard}
                      data-selected={isCurrent ? 'true' : 'false'}
                      data-testid={`build-style-${st.id}`}
                    >
                      <div className={s.cardTop}>
                        <strong>{cleanDisplayCopy(st.name)}</strong>
                        <span className={`${s.badge} ${unlocked ? s.badgeGood : s.badgeGold}`}>
                          {unlocked ? 'Unlocked' : `${st.unlockCost} CC`}
                        </span>
                      </div>
                      <div className={s.swatchDuo}>
                        <span
                          className={s.swatchCircle}
                          style={{ backgroundColor: st.wallColor ?? '#e2e8f0' }}
                          title="Wall tone"
                        />
                        <span
                          className={s.swatchCircle}
                          style={{ backgroundColor: st.floorColor ?? '#b08968' }}
                          title="Floor tone"
                        />
                        <span className={s.cardSub}>Wall and Floor</span>
                      </div>
                      <button
                        type="button"
                        className={`${s.cardBtn} ${isCurrent ? '' : s.cardBtnPrimary}`}
                        disabled={busy || isCurrent}
                        onClick={() =>
                          void perform({
                            type: 'apply_room_style',
                            zoneId: currentRoom,
                            styleId: st.id,
                          })
                        }
                      >
                        {isCurrent ? 'Active Style' : 'Apply Style'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── TAB 4: UPGRADES AND PARTS ──────────────────────────────────────────────────────────────── */}
          {tab === 'upgrades' && (
            <>
              <div className={s.filterBar}>
                <span className={s.badge}>
                  Active Asset: {selectedItem ? itemDisplayName(selectedItem) : 'None selected'}
                </span>
                {selectedItem?.category === 'electronics_pc' && (
                  <span className={`${s.badge} ${s.badgeGood}`}>
                    {computePcStats(selectedItem).memoryGb} GB RAM · {computePcStats(selectedItem).powerDrawWatts} W
                  </span>
                )}
              </div>

              <div className={s.cardRail} data-testid="build-upgrades-rail">
                {selectedUpgrades.map(u => (
                  <div key={u.id} className={s.itemCard}>
                    <div className={s.cardTop}>
                      <strong>{cleanDisplayCopy(u.targetVariant.replaceAll('_', ' '))}</strong>
                      <span className={`${s.badge} ${s.badgeGold}`}>{u.creditsCost} CC</span>
                    </div>
                    <p className={s.cardSub}>Full workstation or appliance tier upgrade.</p>
                    <button
                      type="button"
                      className={`${s.cardBtn} ${s.cardBtnPrimary}`}
                      disabled={busy || !selectedItem}
                      onClick={() =>
                        selectedItem &&
                        void perform({
                          type: 'upgrade_object',
                          instanceId: selectedItem.instanceId,
                          upgradeId: u.id,
                        })
                      }
                    >
                      Upgrade Now
                    </button>
                  </div>
                ))}

                {selectedParts.slice(0, 24).map(part => (
                  <div key={`${part.slot ?? 'veh'}_${part.id}`} className={s.itemCard}>
                    <div className={s.cardTop}>
                      <strong>{cleanDisplayCopy(part.name)}</strong>
                      <span className={`${s.badge} ${s.badgeGold}`}>{part.price} CC</span>
                    </div>
                    <p className={s.cardSub}>
                      {part.slot ? `PC Slot: ${part.slot}` : 'Vehicle Tuning Component'}
                    </p>
                    <button
                      type="button"
                      className={`${s.cardBtn} ${s.cardBtnPrimary}`}
                      disabled={busy || !selectedItem}
                      onClick={() =>
                        selectedItem &&
                        void perform({
                          type: selectedItem.category === 'electronics_pc' ? 'install_pc_part' : 'customize_vehicle',
                          instanceId: selectedItem.instanceId,
                          componentId: part.id,
                          ...(part.slot ? { slot: part.slot } : {}),
                        })
                      }
                    >
                      Install Part
                    </button>
                  </div>
                ))}

                {selectedUpgrades.length === 0 && selectedParts.length === 0 && (
                  <div className={s.itemCard}>
                    <strong>Select a PC or Vehicle</strong>
                    <p className={s.cardSub}>
                      Pick your workstation PC, desk rig, or vehicle in the Furniture tab to view available displays, parts, and tuning upgrades.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── TAB 5: PROPERTIES (ALL 6 RESIDENCES) ───────────────────────────────────────────────────── */}
          {tab === 'properties' && (
            <div className={s.cardRail} data-testid="build-properties-rail">
              {propertyList.map((prop, index) => {
                const isCurrent = prop.id === activePropertyId;
                const isOwned = ownedPropertyIds.includes(prop.id);
                return (
                  <div
                    key={prop.id}
                    className={s.itemCard}
                    data-selected={isCurrent ? 'true' : 'false'}
                    data-testid={`build-property-${prop.id}`}
                  >
                    <div>
                      <div className={s.cardTop}>
                        <strong>{cleanDisplayCopy(prop.name)}</strong>
                        <span className={`${s.badge} ${isCurrent ? s.badgeGood : isOwned ? s.badge : s.badgeGold}`}>
                          {isCurrent ? 'Current Home' : isOwned ? 'Owned' : `${prop.price} CC`}
                        </span>
                      </div>
                      <p className={s.cardSub}>
                        {index === 0 ? 'Lantern Street Residence' : `${index} Market Boulevard`}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={`${s.cardBtn} ${isCurrent ? '' : s.cardBtnPrimary}`}
                      disabled={busy || isCurrent}
                      onClick={() => void perform({ type: 'buy_switch_property', propertyId: prop.id })}
                    >
                      {isCurrent ? 'Living Here' : isOwned ? 'Visit and Switch' : `Acquire (${prop.price} CC)`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
