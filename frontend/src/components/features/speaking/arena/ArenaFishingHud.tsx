'use client';

import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  Fish,
  Mic,
  Trophy,
  X,
} from 'lucide-react';
import type {
  FishRarity,
  FishingHudState,
  MarineSpeciesSpec,
} from './arenaContracts';
import { arenaIslandNames, arenaMarineSpecies } from './arenaCopy';
import { FISHING_MAX_CAST_M, FISHING_MIN_CAST_M } from './arenaFishing';
import styles from './ArenaFishingHud.module.css';

const HINT_FADE_MS = 2800;

export interface ArenaFishingHudProps {
  /** Reactive fishing HUD state */
  state?: FishingHudState | null;
  /** Optional alias for `state` */
  hud?: FishingHudState | null;
  /** Optional high-frequency ref polled smoothly during active charging and reeling */
  hudRef?: React.RefObject<FishingHudState | null>;
  vi: boolean;
  speciesCatalog?: readonly MarineSpeciesSpec[];
  onCast?: () => void;
  onCastChargeStart?: () => void;
  onCastChargeRelease?: () => void;
  onStrike?: () => void;
  onReelStart?: () => void;
  onReelStop?: () => void;
  onUnequip?: () => void;
  onDismissCatch?: () => void;
  onOpenLogbook?: (speciesId?: string) => void;
  onPracticeFishPrompt?: (species: MarineSpeciesSpec) => void;
}

export function formatRarityLabel(rarity: FishRarity, vi: boolean): string {
  switch (rarity) {
    case 'legendary':
      return vi ? 'Huyền thoại' : 'Legendary';
    case 'rare':
      return vi ? 'Quý hiếm' : 'Rare';
    case 'uncommon':
      return vi ? 'Ít gặp' : 'Uncommon';
    default:
      return vi ? 'Phổ biến' : 'Common';
  }
}

/**
 * Custom vector marine silhouette renderer shared by Catch Card and Marine Logbook.
 * Renders distinct anatomical silhouettes (manta ray, shark, lionfish, pelagic torpedo, reef fish)
 * in either full two-tone colour (`discovered = true`) or deep-sea mystery silhouette (`false`).
 */
export function MarineSpeciesArtwork({
  species,
  discovered = true,
  size = 68,
}: {
  species: Pick<MarineSpeciesSpec, 'id' | 'colorPrimary' | 'colorAccent'>;
  discovered?: boolean;
  size?: number;
}) {
  const primary = discovered ? species.colorPrimary : '#1e3a4c';
  const accent = discovered ? species.colorAccent : '#335c75';
  const eyeFill = discovered ? '#0f172a' : 'transparent';
  const id = species.id;

  const isRay = id.includes('ray') || id.includes('manta');
  const isTurtle = id.includes('turtle');
  const isShark = id.includes('shark');
  const isFlying = id.includes('flying');
  const isPelagic = id.includes('tuna') || id.includes('mackerel') || id.includes('barracuda');
  const isLion = id.includes('lion') || id.includes('idol');

  return (
    <svg
      width={size}
      height={Math.round(size * 0.72)}
      viewBox="0 0 96 68"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {isTurtle ? (
        <g>
          <path d="M36 22 L20 10 L30 27 Z" fill={accent} />
          <path d="M36 46 L20 58 L30 41 Z" fill={accent} />
          <path d="M62 24 L74 16 L67 28 Z" fill={accent} />
          <path d="M62 44 L74 52 L67 40 Z" fill={accent} />
          <ellipse cx={18} cy={34} rx={7} ry={5} fill={accent} />
          <ellipse cx={48} cy={34} rx={22} ry={16} fill={primary} stroke={accent} strokeWidth={2} />
          {discovered && (
            <>
              <polygon points="48,22 58,28 58,40 48,46 38,40 38,28" fill="none" stroke={accent} strokeWidth={1.6} />
              <circle cx={15} cy={32} r={1.4} fill={eyeFill} />
            </>
          )}
        </g>
      ) : isFlying ? (
        <g>
          <path d="M34 29 L56 7 L64 28 Z" fill={accent} opacity={0.9} />
          <path d="M38 39 L58 59 L64 40 Z" fill={accent} opacity={0.85} />
          <path d="M12 34 Q38 23 68 29 L84 19 L78 34 L86 49 L68 39 Q38 45 12 34 Z" fill={primary} />
          {discovered && <circle cx={22} cy={32} r={2} fill="#ffffff" />}
          {discovered && <circle cx={22} cy={32} r={1.1} fill={eyeFill} />}
        </g>
      ) : isRay ? (
        <g>
          <path
            d="M14 33 L48 8 L82 33 L56 44 L48 63 L46 44 Z"
            fill={primary}
            stroke={accent}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path d="M34 27 Q48 20 62 27" fill="none" stroke={accent} strokeWidth={2.2} />
          {discovered && (
            <>
              <circle cx={40} cy={19} r={1.8} fill={eyeFill} />
              <circle cx={56} cy={19} r={1.8} fill={eyeFill} />
            </>
          )}
        </g>
      ) : isShark ? (
        <g>
          <path
            d="M8 36 Q30 22 62 26 L86 15 L78 35 L88 50 L62 41 Q32 46 8 36 Z"
            fill={primary}
            stroke={accent}
            strokeWidth={1.6}
          />
          <path d="M40 25 L49 10 L55 26 Z" fill={primary} />
          <path d="M46 15 L49 10 L51 17 Z" fill={accent} />
          {discovered && <circle cx={21} cy={33} r={2} fill={eyeFill} />}
        </g>
      ) : isPelagic ? (
        <g>
          <path
            d="M10 34 Q34 20 68 27 L86 17 L79 34 L86 51 L68 41 Q34 48 10 34 Z"
            fill={primary}
          />
          <path d="M36 24 L50 15 L55 25 Z" fill={accent} />
          <path d="M40 43 L52 51 L56 42 Z" fill={accent} />
          {discovered && <circle cx={21} cy={32} r={2.1} fill="#ffffff" />}
          {discovered && <circle cx={21} cy={32} r={1.1} fill={eyeFill} />}
        </g>
      ) : isLion ? (
        <g>
          <path d="M22 25 L14 10 M32 21 L29 6 M44 20 L46 5 M56 22 L62 8" stroke={accent} strokeWidth={2.6} strokeLinecap="round" />
          <ellipse cx={44} cy={35} rx={24} ry={13} fill={primary} />
          <polygon points="66,35 84,22 80,35 84,48" fill={accent} />
          {discovered && (
            <>
              <line x1={34} y1={24} x2={34} y2={46} stroke={accent} strokeWidth={2.4} />
              <line x1={46} y1={23} x2={46} y2={47} stroke={accent} strokeWidth={2.4} />
              <circle cx={28} cy={32} r={2.2} fill={eyeFill} />
            </>
          )}
        </g>
      ) : (
        <g>
          <path d="M36 21 L52 11 L58 23 Z" fill={accent} />
          <ellipse cx={43} cy={35} rx={25} ry={15} fill={primary} />
          <polygon points="65,35 84,21 79,35 84,49" fill={accent} />
          {discovered && (
            <>
              <path d="M35 21 Q39 35 35 49" fill="none" stroke={accent} strokeWidth={3.2} />
              <path d="M50 22 Q54 35 50 48" fill="none" stroke={accent} strokeWidth={2.6} />
              <circle cx={27} cy={32} r={2.6} fill="#ffffff" />
              <circle cx={27} cy={32} r={1.4} fill={eyeFill} />
            </>
          )}
        </g>
      )}
    </svg>
  );
}

export default function ArenaFishingHud({
  state,
  hud: hudProp,
  hudRef,
  vi,
  speciesCatalog = arenaMarineSpecies,
  onCast,
  onCastChargeStart,
  onCastChargeRelease,
  onStrike,
  onReelStart,
  onReelStop,
  onUnequip,
  onDismissCatch,
  onOpenLogbook,
  onPracticeFishPrompt,
}: ArenaFishingHudProps) {
  const incoming = state ?? hudProp ?? null;
  const [polledState, setPolledState] = useState<FishingHudState | null>(() => incoming ?? hudRef?.current ?? null);
  const [showPromptPractice, setShowPromptPractice] = useState(false);
  const [hintVisible, setHintVisible] = useState(true);

  useEffect(() => {
    if (incoming !== null) setPolledState(incoming);
  }, [incoming]);

  useEffect(() => {
    if (!hudRef) return;
    const tick = () => {
      const cur = hudRef.current;
      if (!cur) {
        setPolledState(prev => (prev === null ? null : null));
        return;
      }
      setPolledState(prev => {
        if (cur.phase === 'idle') {
          return prev === null || prev.phase === 'idle' ? prev : { ...cur };
        }
        return { ...cur };
      });
    };
    tick();
    const id = window.setInterval(tick, 33);
    return () => window.clearInterval(id);
  }, [hudRef]);

  const active =
    hudRef && polledState && (!incoming || polledState.phase === incoming.phase)
      ? polledState
      : incoming ?? polledState;
  const activePhase = active?.phase ?? 'idle';
  const fishApproaching = Boolean(active?.fishApproaching);

  useEffect(() => {
    if (activePhase !== 'caught') setShowPromptPractice(false);
  }, [activePhase, active?.lastCatch?.caughtAt]);

  // Brief contextual hints fade out automatically after 2.8 s so the ocean view remains completely unobstructed
  useEffect(() => {
    if (activePhase !== 'equipped' && activePhase !== 'waiting_bite' && activePhase !== 'escaped') {
      setHintVisible(false);
      return;
    }
    setHintVisible(true);
    const timer = window.setTimeout(() => {
      setHintVisible(false);
    }, HINT_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [activePhase, fishApproaching]);

  if (!active || active.phase === 'idle') return null;

  const clampedPower = Math.max(0, Math.min(1, active.chargePower ?? 0));
  const estimatedCastM =
    FISHING_MIN_CAST_M + (FISHING_MAX_CAST_M - FISHING_MIN_CAST_M) * clampedPower;

  const clampedTension = Math.max(0, Math.min(1, active.tension));
  const clampedProgress = Math.max(0, Math.min(1, active.progress));
  const tensionZone: 'safe' | 'caution' | 'danger' =
    clampedTension >= 0.82 ? 'danger' : clampedTension >= 0.58 ? 'caution' : 'safe';

  const handleCloseCatch = onDismissCatch ?? onUnequip;

  const caughtSpecies: MarineSpeciesSpec | undefined = active.lastCatch
    ? speciesCatalog.find(s => s.id === active.lastCatch?.speciesId) ??
      active.activeSpecies ??
      speciesCatalog[0]
    : undefined;

  const caughtIslandLabel = active.lastCatch
    ? (vi
        ? arenaIslandNames[active.lastCatch.islandId]?.vi
        : arenaIslandNames[active.lastCatch.islandId]?.en) ?? active.lastCatch.islandId
    : '';

  return (
    <div
      className={`${styles.hudScope} ${styles.fishingHud}`}
      data-testid="arena-fishing-hud"
      data-phase={active.phase}
    >
      {/* ── 1. EQUIPPED: Brief 2.8 s auto-fading 1-line hint ── */}
      {active.phase === 'equipped' && (
        <div
          className={`${styles.hintPill} ${hintVisible ? '' : styles.hintHidden}`}
          role="status"
        >
          <span>
            {vi
              ? 'Giữ chuột trái tích lực quăng · F cất cần'
              : 'Hold Left Click to charge cast · F stows rod'}
          </span>
          {(onCast || onCastChargeStart) && (
            <button
              type="button"
              className={styles.hintChipBtn}
              data-testid="arena-fish-cast"
              onPointerDown={() => onCastChargeStart?.()}
              onPointerUp={() => onCastChargeRelease?.()}
              onClick={() => {
                if (!onCastChargeStart) onCast?.();
              }}
            >
              <span>{vi ? 'Thả câu' : 'Cast'}</span>
            </button>
          )}
        </div>
      )}

      {/* ── 2. CHARGING: Sleek minimal horizontal power bar (`0..1` live hold) ── */}
      {active.phase === 'charging' && (
        <div
          className={styles.powerBarWrap}
          data-testid="arena-fish-power-bar"
          data-power={clampedPower.toFixed(3)}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clampedPower * 100)}
          aria-label={vi ? 'Lực quăng cần câu' : 'Fishing cast power'}
        >
          <div className={styles.barMetaRow}>
            <span className={styles.barLabel}>{vi ? 'Lực quăng' : 'Cast power'}</span>
            <span className={`${styles.barValue} ${styles.mono}`}>
              {Math.round(clampedPower * 100)}% · {estimatedCastM.toFixed(1)}m
            </span>
          </div>
          <div className={styles.powerTrack}>
            <div
              className={styles.powerFill}
              style={{ width: `${(clampedPower * 100).toFixed(1)}%` }}
            />
          </div>
        </div>
      )}

      {/* ── 3. WAITING FOR BITE: Brief 2.8 s auto-fading 1-line status ── */}
      {active.phase === 'waiting_bite' && (
        <div
          className={`${styles.hintPill} ${hintVisible ? '' : styles.hintHidden}`}
          role="status"
          aria-live="polite"
        >
          <span>
            {fishApproaching
              ? vi
                ? 'Cá đang tiến lại gần mồi…'
                : 'A fish is investigating your bait…'
              : vi
                ? `Phao đã ổn định · ${active.distanceM.toFixed(1)}m`
                : `Bobber settled · ${active.distanceM.toFixed(1)}m`}
          </span>
        </div>
      )}

      {/* ── 4. BITE ALERT: Compact strike pill ── */}
      {active.phase === 'bite_alert' && (
        <div className={styles.bitePill} role="alert" data-testid="arena-fish-bite-alert">
          <span className={styles.biteLabel}>
            {vi ? 'Cá cắn câu!' : 'Fish on the line!'}
          </span>
          {onStrike && (
            <button
              type="button"
              className={styles.strikeBtn}
              onClick={onStrike}
              data-testid="arena-fish-strike"
            >
              <Fish size={13} />
              <span>{vi ? 'Giật cần!' : 'Strike!'}</span>
            </button>
          )}
        </div>
      )}

      {/* ── 5. REELING: Minimal horizontal tension + reel progress bar (~44 px) ── */}
      {active.phase === 'reeling' && (
        <section
          className={styles.tensionBar}
          data-zone={tensionZone}
          data-testid="arena-fish-tension-panel"
          aria-label={vi ? 'Thanh lực căng dây câu' : 'Fishing line tension bar'}
        >
          <button
            type="button"
            className={styles.reelHoldSurface}
            onPointerDown={() => onReelStart?.()}
            onPointerUp={() => onReelStop?.()}
            onPointerLeave={() => onReelStop?.()}
            onPointerCancel={() => onReelStop?.()}
            data-testid="arena-fish-hold-reel"
          >
            <div className={styles.barMetaRow}>
              <span className={styles.zoneCue} data-zone={tensionZone}>
                <span className={styles.zoneDot} aria-hidden="true" />
                <span>
                  {active.fishPulling || tensionZone === 'danger'
                    ? vi
                      ? 'Nhả tay — Cá vùng mạnh!'
                      : 'Ease Off — Fish Pulling!'
                    : tensionZone === 'caution'
                      ? vi
                        ? 'Nhấp giữ đều nhịp'
                        : 'Pulse Reel Smoothly'
                      : vi
                        ? 'Giữ để thu dây'
                        : 'Hold to Reel'}
                </span>
              </span>
              <span className={`${styles.barValue} ${styles.mono}`}>
                {active.distanceM.toFixed(1)}m · {Math.round(clampedProgress * 100)}%
              </span>
            </div>

            <div className={styles.tensionTrack}>
              <div
                className={styles.tensionFill}
                data-zone={tensionZone}
                style={{ width: `${(clampedTension * 100).toFixed(1)}%` }}
              />
              <span className={styles.dangerTick} aria-hidden="true" />
            </div>

            <div className={styles.reelHairlineTrack}>
              <div
                className={styles.reelHairlineFill}
                style={{ width: `${(clampedProgress * 100).toFixed(1)}%` }}
              />
            </div>
          </button>
        </section>
      )}

      {/* ── 6. ESCAPED: Brief 2.8 s auto-fading 1-line notice ── */}
      {active.phase === 'escaped' && (
        <div
          className={`${styles.hintPill} ${hintVisible ? '' : styles.hintHidden}`}
          role="status"
        >
          <span>
            {vi
              ? 'Cá đã tuột câu · Giữ chuột trái để quăng lại'
              : 'The fish slipped free · Hold Left Click to cast again'}
          </span>
        </div>
      )}

      {/* ── 7. CAUGHT: Compact Catch Result Card ── */}
      {active.phase === 'caught' && active.lastCatch && caughtSpecies && (
        <section
          className={styles.catchCard}
          data-testid="arena-fish-catch-card"
          aria-label={vi ? `Câu được ${caughtSpecies.nameVi}` : `Caught ${caughtSpecies.nameEn}`}
        >
          <div className={styles.cardTopRow}>
            <div className={styles.badgeGroup}>
              <span className={styles.rarityBadge} data-rarity={active.lastCatch.rarity}>
                {formatRarityLabel(active.lastCatch.rarity, vi)}
              </span>
              {active.lastCatch.isNewRecord && (
                <span className={styles.rarityBadge} data-rarity="legendary">
                  <Trophy size={11} />
                  <span>{vi ? 'Kỷ lục mới!' : 'New Record!'}</span>
                </span>
              )}
            </div>
            {handleCloseCatch && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={handleCloseCatch}
                aria-label={vi ? 'Đóng thẻ kết quả câu cá' : 'Close catch card'}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className={styles.catchHero}>
            <div className={styles.fishArtBadge}>
              <MarineSpeciesArtwork species={caughtSpecies} discovered={true} size={62} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 className={styles.speciesTitle}>
                {vi ? caughtSpecies.nameVi : caughtSpecies.nameEn}
              </h3>
              <div className={styles.speciesSub}>
                {vi ? caughtSpecies.nameEn : caughtSpecies.nameVi} ·{' '}
                <em className={styles.speciesSci}>{caughtSpecies.scientificName}</em>
              </div>
              <small className={styles.speciesHabitat}>
                {vi ? caughtSpecies.habitatVi : caughtSpecies.habitatEn}
              </small>
            </div>
          </div>

          <div className={styles.catchStatsRow}>
            <div className={styles.scoreCell}>
              <small>{vi ? 'Cân nặng' : 'Weight'}</small>
              <b className={styles.mono}>{active.lastCatch.weightKg.toFixed(2)} kg</b>
            </div>
            <div className={styles.scoreCell}>
              <small>{vi ? 'Chiều dài' : 'Length'}</small>
              <b className={styles.mono}>{active.lastCatch.lengthCm.toFixed(1)} cm</b>
            </div>
            <div className={styles.scoreCell}>
              <small>{vi ? 'Vùng biển' : 'Location'}</small>
              <b>{caughtIslandLabel}</b>
            </div>
          </div>

          <div className={styles.vocabGrid}>
            {caughtSpecies.vocabWords.map(w => (
              <span key={w} className={styles.vocabChip}>
                <b lang="en">{w}</b>
              </span>
            ))}
          </div>

          {showPromptPractice && (
            <div className={styles.cueBox} data-testid="arena-fish-speaking-prompt">
              <small>{vi ? 'Thử thách nói tiếng Anh:' : 'Speak aloud challenge:'}</small>
              <p className={styles.promptTextEn} lang="en">
                {caughtSpecies.speakingPromptEn}
              </p>
              {vi && <p className={styles.promptTextVi}>{caughtSpecies.speakingPromptVi}</p>}
            </div>
          )}

          <div className={styles.cardActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              data-testid="arena-fish-practice-btn"
              onClick={() => {
                setShowPromptPractice(true);
                onPracticeFishPrompt?.(caughtSpecies);
              }}
            >
              <Mic size={13} />
              <span>
                {showPromptPractice
                  ? vi
                    ? 'Đang mở gợi ý'
                    : 'Prompt Active'
                  : vi
                    ? 'Luyện nói về loài cá này'
                    : 'Practice Speaking'}
              </span>
            </button>

            <div className={styles.secondaryActions}>
              {onOpenLogbook && (
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => onOpenLogbook(caughtSpecies.id)}
                >
                  <BookOpen size={13} />
                  <span>{vi ? 'Sổ tay' : 'Logbook'}</span>
                </button>
              )}
              {handleCloseCatch && (
                <button type="button" className={styles.btn} onClick={handleCloseCatch}>
                  <Check size={13} />
                  <span>{vi ? 'Tiếp tục' : 'Continue'}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
