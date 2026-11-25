'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Compass,
  Fish,
  Mic,
  Play,
  RotateCcw,
  Trophy,
  TreePalm,
  Waves,
  X,
} from 'lucide-react';
import type {
  FishRarity,
  FruitHarvestLog,
  FruitKind,
  FruitSpec,
  MarineCollectionState,
  MarineSpeciesSpec,
} from './arenaContracts';
import {
  arenaFruitDetails,
  arenaIslandNames,
  arenaMarineSpecies,
  type ExtendedFruitSpec,
} from './arenaCopy';
import { formatRarityLabel, MarineSpeciesArtwork } from './ArenaFishingHud';
import hud from './arenaHud.module.css';

export interface CollectionPromptPayload {
  titleEn: string;
  titleVi: string;
  promptEn: string;
  promptVi: string;
  vocabWords: readonly string[];
}

export interface ArenaCollectionDrawerProps {
  open: boolean;
  onClose: () => void;
  vi: boolean;
  marineCollection?: MarineCollectionState;
  fruitHarvest?: FruitHarvestLog;
  speciesCatalog?: readonly MarineSpeciesSpec[];
  fruitCatalog?: readonly FruitSpec[];
  initialTab?: 'marine' | 'fruits';
  initialSpeciesId?: string | null;
  onLaunchSpeakingPrompt?: (prompt: CollectionPromptPayload) => void;
}

const EMPTY_MARINE: MarineCollectionState = {
  catchesBySpecies: {},
  totalCaught: 0,
};

const EMPTY_FRUITS: FruitHarvestLog = {
  coconut: 0,
  mango: 0,
  banana: 0,
  papaya: 0,
};

function FruitArtwork({ kind, color }: { kind: FruitKind; color: string }) {
  return (
    <svg width={52} height={52} viewBox="0 0 56 56" aria-hidden="true">
      {kind === 'coconut' && (
        <g>
          <circle cx={28} cy={30} r={17} fill="#16a34a" stroke="#14532d" strokeWidth={1.8} />
          <ellipse cx={28} cy={17} rx={8} ry={3.5} fill="#bbf7d0" />
          <line x1={31} y1={16} x2={39} y2={6} stroke="#0ea5e9" strokeWidth={2.6} strokeLinecap="round" />
        </g>
      )}
      {kind === 'mango' && (
        <g>
          <path
            d="M20 13 C34 10, 44 21, 40 35 C37 45, 23 48, 17 40 C12 32, 12 16, 20 13 Z"
            fill={color}
            stroke="#b45309"
            strokeWidth={1.6}
          />
          <path d="M23 12 Q29 6 36 10 Q30 14 23 12 Z" fill="#16a34a" />
        </g>
      )}
      {kind === 'banana' && (
        <g>
          <path
            d="M15 16 C18 34, 30 43, 44 38 C36 46, 16 42, 12 22 Z"
            fill={color}
            stroke="#a16207"
            strokeWidth={1.6}
          />
          <path
            d="M21 13 C24 29, 34 37, 46 33 C39 40, 22 36, 18 18 Z"
            fill="#fde047"
            stroke="#a16207"
            strokeWidth={1.4}
          />
        </g>
      )}
      {kind === 'papaya' && (
        <g>
          <ellipse cx={28} cy={30} rx={14} ry={19} fill={color} stroke="#c2410c" strokeWidth={1.6} />
          <ellipse cx={28} cy={32} rx={7} ry={11} fill="#fed7aa" />
          <circle cx={26} cy={29} r={1.6} fill="#1c1917" />
          <circle cx={30} cy={31} r={1.6} fill="#1c1917" />
          <circle cx={27} cy={35} r={1.6} fill="#1c1917" />
          <circle cx={30} cy={36} r={1.6} fill="#1c1917" />
        </g>
      )}
    </svg>
  );
}

export default function ArenaCollectionDrawer({
  open,
  onClose,
  vi,
  marineCollection = EMPTY_MARINE,
  fruitHarvest = EMPTY_FRUITS,
  speciesCatalog = arenaMarineSpecies,
  fruitCatalog,
  initialTab = 'marine',
  initialSpeciesId = null,
  onLaunchSpeakingPrompt,
}: ArenaCollectionDrawerProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const [tab, setTab] = useState<'marine' | 'fruits'>(initialTab);
  const [rarityFilter, setRarityFilter] = useState<'all' | FishRarity>('all');
  const [selectedSpeciesId, setSelectedSpeciesId] = useState<string>(
    initialSpeciesId ?? speciesCatalog[0]?.id ?? 'clownfish',
  );
  const [activePromptCard, setActivePromptCard] = useState<CollectionPromptPayload | null>(null);
  const [practiceSecondsLeft, setPracticeSecondsLeft] = useState<number>(0);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      if (initialSpeciesId) setSelectedSpeciesId(initialSpeciesId);
    } else {
      setPracticeSecondsLeft(0);
      setActivePromptCard(null);
    }
  }, [open, initialTab, initialSpeciesId]);

  // Native `<dialog>` lifecycle + pointer-outside light-dismiss fallback
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          // Guard if already modal
        }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      dialog.returnValue = '';
      onClose();
    };
    dialog.addEventListener('close', handleClose);

    let cleanOutside: (() => void) | undefined;
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      const onDown = (e: PointerEvent) => {
        pressedOutside = isOutside(e);
      };
      const onUp = (e: PointerEvent) => {
        if (pressedOutside && isOutside(e) && dialog.open) dialog.close();
      };
      dialog.addEventListener('pointerdown', onDown);
      dialog.addEventListener('pointerup', onUp);
      cleanOutside = () => {
        dialog.removeEventListener('pointerdown', onDown);
        dialog.removeEventListener('pointerup', onUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      cleanOutside?.();
    };
  }, [onClose]);

  // Local 45-second self-speaking countdown inside the Field Guide
  useEffect(() => {
    if (practiceSecondsLeft <= 0) return;
    const id = window.setInterval(() => {
      setPracticeSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [practiceSecondsLeft]);

  const discoveredSpeciesCount = useMemo(() => {
    let count = 0;
    for (const sp of speciesCatalog) {
      if ((marineCollection.catchesBySpecies[sp.id]?.count ?? 0) > 0) count++;
    }
    return count;
  }, [marineCollection.catchesBySpecies, speciesCatalog]);

  const totalFruitsHarvested =
    (fruitHarvest.coconut ?? 0) +
    (fruitHarvest.mango ?? 0) +
    (fruitHarvest.banana ?? 0) +
    (fruitHarvest.papaya ?? 0);

  const filteredSpecies = useMemo(() => {
    if (rarityFilter === 'all') return speciesCatalog;
    return speciesCatalog.filter(sp => sp.rarity === rarityFilter);
  }, [rarityFilter, speciesCatalog]);

  const selectedSpecies = useMemo(
    () => speciesCatalog.find(s => s.id === selectedSpeciesId) ?? speciesCatalog[0],
    [selectedSpeciesId, speciesCatalog],
  );

  const selectedCatchRecord = selectedSpecies
    ? marineCollection.catchesBySpecies[selectedSpecies.id]
    : undefined;
  const isSelectedDiscovered = (selectedCatchRecord?.count ?? 0) > 0;

  const resolvedFruits: readonly ExtendedFruitSpec[] = useMemo(() => {
    if (!fruitCatalog) return arenaFruitDetails;
    return fruitCatalog.map(f => {
      const rich = arenaFruitDetails.find(d => d.kind === f.kind);
      return rich ? { ...rich, ...f } : {
        ...f,
        islandHintEn: 'Palm Beach Orchard',
        islandHintVi: 'Vườn nhiệt đới Bãi Dừa',
        vocabWords: ['fresh', 'sweet', 'tropical'],
        speakingPromptEn: f.vocabPhraseEn,
        speakingPromptVi: f.vocabPhraseVi,
      };
    });
  }, [fruitCatalog]);

  const triggerPromptPractice = (payload: CollectionPromptPayload) => {
    setActivePromptCard(payload);
    setPracticeSecondsLeft(45);
    onLaunchSpeakingPrompt?.(payload);
  };

  return (
    <div className={hud.hudScope}>
      <dialog
        ref={dialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        className={hud.modalDialog}
        aria-labelledby={titleId}
        data-testid="arena-collection-drawer"
      >
        <header className={hud.modalHeader}>
          <div className={hud.modalTitleBlock}>
            <span className={hud.modalEyebrow}>
              {vi ? 'CẨM NANG KHÁM PHÁ QUẦN ĐẢO ECHO' : 'ECHO ARCHIPELAGO FIELD GUIDE'}
            </span>
            <h2 id={titleId} className={hud.modalTitle}>
              {vi
                ? 'Sổ Tay Sinh Vật Biển và Giỏ Trái Cây Nhiệt Đới'
                : 'Marine Species Logbook and Tropical Fruit Harvest'}
            </h2>
          </div>

          <div className={hud.modalHeaderActions}>
            <div className={hud.modeSegment} role="tablist" aria-label={vi ? 'Danh mục sổ tay' : 'Field guide tabs'}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'marine'}
                className={hud.modeSegmentBtn}
                onClick={() => setTab('marine')}
                data-testid="arena-collection-tab-marine"
              >
                <Fish size={14} />
                <span>
                  {vi ? 'Sinh vật biển' : 'Marine Logbook'} ({discoveredSpeciesCount}/{speciesCatalog.length})
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'fruits'}
                className={hud.modeSegmentBtn}
                onClick={() => setTab('fruits')}
                data-testid="arena-collection-tab-fruits"
              >
                <TreePalm size={14} />
                <span>
                  {vi ? 'Trái cây nhiệt đới' : 'Tropical Harvest'} ({totalFruitsHarvested})
                </span>
              </button>
            </div>

            <button
              type="button"
              className={hud.iconBtn}
              onClick={onClose}
              aria-label={vi ? 'Đóng sổ tay' : 'Close field guide'}
              autoFocus
            >
              <X size={17} />
            </button>
          </div>
        </header>

        {/* ── TAB 1: MARINE LOGBOOK (14 SPECIES) ── */}
        {tab === 'marine' && (
          <>
            <div className={hud.worldMapFilterBar}>
              <div className={hud.filterGroup} role="group" aria-label={vi ? 'Lọc theo độ hiếm' : 'Filter by rarity'}>
                {(
                  [
                    ['all', vi ? 'Tất cả (14)' : 'All (14)'],
                    ['common', vi ? 'Phổ biến' : 'Common'],
                    ['uncommon', vi ? 'Ít gặp' : 'Uncommon'],
                    ['rare', vi ? 'Quý hiếm' : 'Rare'],
                    ['legendary', vi ? 'Huyền thoại' : 'Legendary'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={hud.filterPill}
                    aria-pressed={rarityFilter === key}
                    onClick={() => setRarityFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className={`${hud.statusChip} ${hud.mono}`}>
                <Trophy size={12} />
                <span>
                  {vi
                    ? `Đã câu tổng cộng: ${marineCollection.totalCaught}`
                    : `Total catches: ${marineCollection.totalCaught}`}
                </span>
              </span>
            </div>

            <div className={hud.collectionBody}>
              {/* 14-Species Grid */}
              <div className={hud.speciesGridPane} role="listbox" aria-label={vi ? 'Danh sách 14 loài cá' : '14 marine species'}>
                {filteredSpecies.map(sp => {
                  const rec = marineCollection.catchesBySpecies[sp.id];
                  const caught = (rec?.count ?? 0) > 0;
                  const selected = selectedSpecies?.id === sp.id;
                  return (
                    <button
                      key={sp.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-caught={caught ? 'true' : 'false'}
                      className={hud.speciesTile}
                      onClick={() => setSelectedSpeciesId(sp.id)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <span className={hud.rarityBadge} data-rarity={sp.rarity}>
                          {formatRarityLabel(sp.rarity, vi)}
                        </span>
                        {caught && (
                          <span className={hud.mono} style={{ fontSize: 10.5, fontWeight: 750, color: 'var(--ah-emerald)' }}>
                            ×{rec.count}
                          </span>
                        )}
                      </div>

                      <div style={{ alignSelf: 'center', padding: '4px 0' }}>
                        <MarineSpeciesArtwork species={sp} discovered={caught} size={74} />
                      </div>

                      <div>
                        <b style={{ display: 'block', fontSize: 12.5, fontWeight: 800 }}>
                          {caught
                            ? vi
                              ? sp.nameVi
                              : sp.nameEn
                            : sp.id === 'manta_ray' || sp.id === 'sea_turtle'
                              ? vi
                                ? 'Sinh vật bảo tồn bí ẩn'
                                : 'Undiscovered Wildlife'
                              : vi
                                ? 'Chưa câu được'
                                : 'Undiscovered Species'}
                        </b>
                        <small style={{ fontSize: 11, color: 'var(--ah-muted)' }}>
                          {caught
                            ? `${rec.bestWeightKg.toFixed(2)} kg · ${rec.bestLengthCm.toFixed(0)} cm`
                            : `${sp.depthMin}–${sp.depthMax}m`}
                        </small>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Selected Species Detail & English Speaking Launcher */}
              {selectedSpecies && (
                <aside className={hud.worldMapSidebar} data-testid="arena-marine-inspector">
                  <div className={hud.inspectorCard}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span className={hud.rarityBadge} data-rarity={selectedSpecies.rarity}>
                        {formatRarityLabel(selectedSpecies.rarity, vi)}
                      </span>
                      <span className={`${hud.badge} ${hud.mono}`}>
                        <Waves size={11} />
                        <span>
                          {selectedSpecies.depthMin}–{selectedSpecies.depthMax}m
                        </span>
                      </span>
                      {isSelectedDiscovered && (
                        <span className={hud.cefrBadge} data-cefr="A2">
                          <CheckCircle2 size={11} />
                          <span>{vi ? 'Đã ghi danh sổ tay' : 'Logged'}</span>
                        </span>
                      )}
                    </div>

                    <div className={hud.catchHero}>
                      <div className={hud.fishArtBadge}>
                        <MarineSpeciesArtwork
                          species={selectedSpecies}
                          discovered={isSelectedDiscovered}
                          size={66}
                        />
                      </div>
                      <div>
                        <h3 className={hud.inspectorTitle}>
                          {vi ? selectedSpecies.nameVi : selectedSpecies.nameEn}
                        </h3>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ah-accent)' }}>
                          {vi ? selectedSpecies.nameEn : selectedSpecies.nameVi}
                        </div>
                        <small style={{ fontStyle: 'italic', color: 'var(--ah-muted)', fontSize: 11.5 }}>
                          {selectedSpecies.scientificName}
                        </small>
                      </div>
                    </div>

                    <p className={hud.inspectorDesc}>
                      {vi ? selectedSpecies.habitatVi : selectedSpecies.habitatEn}
                    </p>

                    {isSelectedDiscovered && selectedCatchRecord ? (
                      <div className={hud.catchStatsRow}>
                        <div className={hud.scoreCell}>
                          <small>{vi ? 'Kỷ lục nặng' : 'Best Weight'}</small>
                          <b className={hud.mono}>{selectedCatchRecord.bestWeightKg.toFixed(2)} kg</b>
                        </div>
                        <div className={hud.scoreCell}>
                          <small>{vi ? 'Kỷ lục dài' : 'Best Length'}</small>
                          <b className={hud.mono}>{selectedCatchRecord.bestLengthCm.toFixed(1)} cm</b>
                        </div>
                        <div className={hud.scoreCell}>
                          <small>{vi ? 'Đảo câu được' : 'Island Caught'}</small>
                          <b style={{ fontSize: 12 }}>
                            {(vi
                              ? arenaIslandNames[selectedCatchRecord.lastIslandId]?.vi
                              : arenaIslandNames[selectedCatchRecord.lastIslandId]?.en) ??
                              selectedCatchRecord.lastIslandId}
                          </b>
                        </div>
                      </div>
                    ) : (
                      <div className={hud.cueBox}>
                        <small>{vi ? 'Gợi ý vùng biển tìm kiếm:' : 'Where to cast your line:'}</small>
                        <span style={{ fontSize: 12 }}>
                          {selectedSpecies.islandZoneIds
                            .slice(0, 2)
                            .map(id => (vi ? arenaIslandNames[id]?.vi : arenaIslandNames[id]?.en) ?? id)
                            .join(' · ')}
                        </span>
                      </div>
                    )}

                    <div>
                      <small style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 750, color: 'var(--ah-muted)' }}>
                        {vi ? 'Từ vựng tiếng Anh miêu tả:' : 'Descriptive English vocabulary:'}
                      </small>
                      <div className={hud.vocabGrid}>
                        {selectedSpecies.vocabWords.map(word => (
                          <span key={word} className={hud.vocabChip}>
                            <b lang="en">{word}</b>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className={hud.phrasesWell}>
                      <small>{vi ? 'Chủ đề luyện nói cùng loài cá này:' : 'Speaking prompt:'}</small>
                      <p className={hud.promptTextEn} lang="en">
                        {selectedSpecies.speakingPromptEn}
                      </p>
                      {vi && <p className={hud.promptTextVi}>{selectedSpecies.speakingPromptVi}</p>}
                    </div>

                    <button
                      type="button"
                      className={hud.btnPrimary}
                      onClick={() =>
                        triggerPromptPractice({
                          titleEn: selectedSpecies.nameEn,
                          titleVi: selectedSpecies.nameVi,
                          promptEn: selectedSpecies.speakingPromptEn,
                          promptVi: selectedSpecies.speakingPromptVi,
                          vocabWords: selectedSpecies.vocabWords,
                        })
                      }
                    >
                      <Mic size={14} />
                      <span>{vi ? 'Bắt đầu 45s luyện nói' : 'Start 45s Speaking Turn'}</span>
                    </button>
                  </div>

                  {activePromptCard && (
                    <div className={hud.drillPanel} data-phase="talk" role="timer" aria-live="polite">
                      <div className={hud.drillTopRow}>
                        <span className={hud.badge}>
                          <Clock size={12} />
                          <span>{vi ? activePromptCard.titleVi : activePromptCard.titleEn}</span>
                        </span>
                        <b className={`${hud.drillCountdown} ${hud.mono}`}>{practiceSecondsLeft}s</b>
                      </div>
                      <p className={hud.promptTextEn} lang="en">
                        {activePromptCard.promptEn}
                      </p>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}>
                        <button
                          type="button"
                          className={hud.btn}
                          onClick={() => setPracticeSecondsLeft(45)}
                        >
                          <RotateCcw size={13} />
                          <span>{vi ? 'Đặt lại 45s' : 'Reset 45s'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </aside>
              )}
            </div>
          </>
        )}

        {/* ── TAB 2: TROPICAL FRUIT HARVEST BASKET (4 FRUITS) ── */}
        {tab === 'fruits' && (
          <div className={hud.fruitGridPane} data-testid="arena-fruit-harvest-grid">
            {resolvedFruits.map(fruit => {
              const harvested = fruitHarvest[fruit.kind] ?? 0;
              return (
                <article key={fruit.kind} className={hud.fruitCard}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <FruitArtwork kind={fruit.kind} color={fruit.color} />
                      <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
                          {vi ? fruit.nameVi : fruit.nameEn}
                        </h3>
                        <small style={{ fontSize: 11.5, color: 'var(--ah-accent)', fontWeight: 700 }}>
                          {vi ? fruit.nameEn : fruit.nameVi}
                        </small>
                      </div>
                    </div>
                    <span className={`${hud.statusChip} ${hud.mono}`}>
                      {vi ? `Thu hoạch: ${harvested}` : `Harvested: ${harvested}`}
                    </span>
                  </div>

                  <small style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--ah-muted)' }}>
                    <Compass size={12} />
                    <span>{vi ? fruit.islandHintVi : fruit.islandHintEn}</span>
                  </small>

                  <div className={hud.vocabGrid}>
                    {fruit.vocabWords.map(w => (
                      <span key={w} className={hud.vocabChip}>
                        <b lang="en">{w}</b>
                      </span>
                    ))}
                  </div>

                  <div className={hud.phrasesWell}>
                    <small>{vi ? 'Câu mẫu tự nhiên:' : 'Natural English sentence:'}</small>
                    <p className={hud.promptTextEn} lang="en">
                      “{fruit.vocabPhraseEn}”
                    </p>
                    {vi && <p className={hud.promptTextVi}>{fruit.vocabPhraseVi}</p>}
                  </div>

                  <div className={hud.cueBox}>
                    <small>{vi ? 'Gợi ý mở lời:' : 'Speaking prompt:'}</small>
                    <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                      {vi ? fruit.speakingPromptVi : fruit.speakingPromptEn}
                    </span>
                  </div>

                  <button
                    type="button"
                    className={hud.btnPrimary}
                    onClick={() => {
                      setTab('marine');
                      triggerPromptPractice({
                        titleEn: fruit.nameEn,
                        titleVi: fruit.nameVi,
                        promptEn: fruit.speakingPromptEn,
                        promptVi: fruit.speakingPromptVi,
                        vocabWords: fruit.vocabWords,
                      });
                    }}
                  >
                    <Play size={14} />
                    <span>{vi ? 'Luyện nói về trái cây này (45s)' : 'Practise Fruit Prompt (45s)'}</span>
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </dialog>
    </div>
  );
}
