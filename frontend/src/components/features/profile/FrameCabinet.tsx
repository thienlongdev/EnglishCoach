'use client';

import React, { useMemo, useState } from 'react';
import { ArrowRight, Award, BookOpen, Calendar, Check, CheckCircle2, AlertCircle, Crown, Flame, History, Loader2, Lock, Sun } from 'lucide-react';
import type { AvatarFrameDto, AvatarFrameLineage } from '@/types/avatarFrame';
import { TIER_DISPLAY_NAMES } from '@/types/avatarFrame';
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame';
import { getFramePresentationConfig } from '@/components/common/frame/visualThemes';
import { formatAvatarFrameRequirement } from '@/components/features/avatar-frame/formatRequirement';
import styles from './profileGlass.module.css';

type LineageFilter = 'ALL' | AvatarFrameLineage;

/** Lineage tabs in the wardrobe's order; a tab appears only when the catalogue has a frame of that lineage. */
const LINEAGES: { key: AvatarFrameLineage; label: string; Icon: typeof Flame }[] = [
  { key: 'ACHIEVEMENT', label: 'Thành tựu', Icon: Flame },
  { key: 'RANKED', label: 'Xếp hạng', Icon: Award },
  { key: 'STANDARD', label: 'Chuẩn hóa', Icon: BookOpen },
  { key: 'LEGACY', label: 'Di sản', Icon: History },
  { key: 'SEASONAL', label: 'Bốn mùa', Icon: Sun },
  { key: 'PREMIUM', label: 'Hội viên', Icon: Crown },
  { key: 'EVENT', label: 'Sự kiện', Icon: Calendar },
  { key: 'GARDEN', label: 'Echo Garden', Icon: BookOpen },
];

/** How many frames the cabinet shows before "Xem tất cả" (the wardrobe dialog holds the whole collection); 11 + the
 * "Xem tất cả" tile fill whole rows of 2, 3 and 4 columns. */
const GLIMPSE = 11;

/** The frame's own colour, used for the stage light around it (declared on the element that carries it). */
export function frameAccent(frame: AvatarFrameDto | null | undefined): string {
  return frame ? getFramePresentationConfig(frame).primaryColor || '#818cf8' : '#38bdf8';
}

function frameState(f: AvatarFrameDto): { key: 'equipped' | 'owned' | 'eligible' | 'progressing' | 'locked'; text: string } {
  if (f.ownership?.equipped) return { key: 'equipped', text: 'Đang dùng' };
  if (f.ownership?.owned) return { key: 'owned', text: 'Đã sở hữu' };
  if (f.progress?.status === 'ELIGIBLE') return { key: 'eligible', text: 'Đủ điều kiện' };
  if (f.progress?.status === 'PROGRESSING') return { key: 'progressing', text: 'Đang tiến độ' };
  return { key: 'locked', text: 'Chưa mở' };
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

export interface FrameCabinetProps {
  catalogue: AvatarFrameDto[];
  equippedFrame: AvatarFrameDto | null;
  isLoading: boolean;
  avatarUrl: string | null;
  displayName: string;
  busy: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
  onEquip: (slug: string) => void;
  onUnequip: () => void;
  onOpenAll: () => void;
}

/**
 * Tủ Khung Danh Hiệu on the profile page: a glimpse of the real catalogue (server order, server ownership / progress /
 * eligibility) with lineage tabs, and a showcase of the selected frame with the same equip / unequip actions as the
 * wardrobe. Nothing here decides ownership or progress; the whole collection and its status filters live in the wardrobe.
 */
export function FrameCabinet({ catalogue, equippedFrame, isLoading, avatarUrl, displayName, busy, message, onEquip, onUnequip, onOpenAll }: FrameCabinetProps) {
  const [lineage, setLineage] = useState<LineageFilter>('ALL');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const tabs = LINEAGES.filter((l) => catalogue.some((f) => f.lineage === l.key));
  const filtered = useMemo(() => (lineage === 'ALL' ? catalogue : catalogue.filter((f) => f.lineage === lineage)), [catalogue, lineage]);
  const shown = filtered.slice(0, filtered.length > GLIMPSE + 1 ? GLIMPSE : GLIMPSE + 1);
  const hidden = filtered.length - shown.length;
  const selected = catalogue.find((f) => f.slug === selectedSlug) ?? equippedFrame ?? catalogue.find((f) => f.ownership?.owned) ?? catalogue[0] ?? null;

  return (
    <>
      <section className={`${styles.panel} ${styles.enter2}`} data-tone="gold" aria-labelledby="frame-cabinet-title" data-testid="frame-cabinet">
        <div className={styles.cabinetHead}>
          <span className={styles.icon} data-tone="gold" aria-hidden="true"><Crown className="h-5 w-5" /></span>
          <div className={styles.headText}>
            <h2 id="frame-cabinet-title" className={styles.title}>Tủ Khung Danh Hiệu</h2>
            <p className={styles.lead}>
              {catalogue.length > 0
                ? `${catalogue.filter((f) => f.ownership?.owned).length} / ${catalogue.length} khung đã sở hữu`
                : 'Khung danh hiệu bạn nhận được từ hành trình học tập.'}
            </p>
          </div>
          <button type="button" className={`${styles.btnGhost} ${styles.btnSm}`} onClick={onOpenAll}>
            Xem tất cả <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {tabs.length > 0 && (
          <div className={styles.tabs} role="tablist" aria-label="Dòng khung">
            <button type="button" role="tab" aria-selected={lineage === 'ALL'} className={styles.tab} onClick={() => setLineage('ALL')}>
              Tất cả ({catalogue.length})
            </button>
            {tabs.map(({ key, label, Icon }) => (
              <button key={key} type="button" role="tab" aria-selected={lineage === key} className={styles.tab} onClick={() => setLineage(key)}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
              </button>
            ))}
          </div>
        )}

        {isLoading && catalogue.length === 0 ? (
          <div className={styles.tileGrid} aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => <span key={i} className={styles.skeletonTile} />)}
          </div>
        ) : catalogue.length === 0 ? (
          <p className={styles.cabinetEmpty}>Chưa tải được tủ khung. Hãy mở lại trang sau.</p>
        ) : (
          <div className={styles.tileGrid}>
            {shown.map((f) => {
              const state = frameState(f);
              const req = !f.ownership?.owned ? formatAvatarFrameRequirement(f.progress) : null;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={selected?.slug === f.slug}
                  aria-label={`${f.name} · ${state.text}`}
                  className={styles.tile}
                  data-locked={!f.ownership?.owned || undefined}
                  style={{ '--fa': frameAccent(f) } as React.CSSProperties}
                  onClick={() => setSelectedSlug(f.slug)}
                >
                  <span className={styles.tileArt}>
                    <AvatarWithFrame size="md" context="leaderboard" frame={f} avatarUrl={avatarUrl} fallbackName={displayName} />
                  </span>
                  <span className={styles.tileName}>{f.name}</span>
                  {state.key === 'progressing' && req ? (
                    <>
                      <span className={styles.tileProgress}><span className="truncate">{req.cardProgress}</span><span>{Math.round(f.progress?.percent ?? 0)}%</span></span>
                      <span className={styles.meter} aria-hidden="true"><span style={{ width: `${Math.min(100, f.progress?.percent ?? 0)}%` }} /></span>
                    </>
                  ) : (
                    <span className={styles.tileState} data-state={state.key}>
                      {state.key === 'equipped' && <Check className="h-3 w-3" aria-hidden="true" />}
                      {state.key === 'locked' && <Lock className="h-3 w-3" aria-hidden="true" />}
                      {state.key === 'locked' && req?.cardProgress ? req.cardProgress : state.text}
                    </span>
                  )}
                </button>
              );
            })}
            {hidden > 0 && (
              <button type="button" className={styles.tileMore} onClick={onOpenAll}>
                <span className="text-lg font-extrabold">+{hidden}</span>
                Xem tất cả
              </button>
            )}
          </div>
        )}
      </section>

      {selected && <FrameShowcase frame={selected} avatarUrl={avatarUrl} displayName={displayName} busy={busy} message={message} onEquip={onEquip} onUnequip={onUnequip} />}
    </>
  );
}

function FrameShowcase({ frame, avatarUrl, displayName, busy, message, onEquip, onUnequip }: {
  frame: AvatarFrameDto; avatarUrl: string | null; displayName: string; busy: boolean;
  message: FrameCabinetProps['message']; onEquip: (slug: string) => void; onUnequip: () => void;
}) {
  const owned = !!frame.ownership?.owned;
  const equipped = !!frame.ownership?.equipped;
  const req = formatAvatarFrameRequirement(frame.progress);
  const until = formatDate(frame.ownership?.expiresAt);
  return (
    <section className={`${styles.showcase} ${styles.enter3}`} style={{ '--fa': frameAccent(frame) } as React.CSSProperties} aria-label={`Khung ${frame.name}`} data-testid="frame-showcase">
      <div className={styles.showcaseBody}>
        <div className={styles.showcaseStage} style={{ height: frame.tier === 'SSS' ? '11rem' : frame.tier === 'SS' ? '10rem' : '9rem' }}>
          <span className={styles.glowDisc} aria-hidden="true" />
          <span className={styles.pedestal} aria-hidden="true" />
          <span className={styles.avatarSpot}>
            <AvatarWithFrame key={frame.slug} size="lg" context="profile" frame={frame} avatarUrl={avatarUrl} fallbackName={displayName} />
          </span>
        </div>
        <div className={styles.showcaseInfo}>
          <span className={styles.tierChip}>{TIER_DISPLAY_NAMES[frame.tier]} ({frame.tier})</span>
          <h3 className={styles.showcaseName}>{frame.name}</h3>
          <dl className={styles.facts}>
            {owned ? (
              <>
                <div className={styles.fact}><dt className={styles.factKey}>Trạng thái</dt><dd className={styles.factVal} data-tone="ok">{equipped ? 'Đang trang bị' : 'Đã sở hữu'}</dd></div>
                <div className={styles.fact}><dt className={styles.factKey}>Thời hạn</dt><dd className={styles.factVal}>{frame.ownership?.expiresAt ? (until ? `Đến ${until}` : 'Có hạn') : 'Sở hữu vĩnh viễn'}</dd></div>
              </>
            ) : req.isMultiCondition ? (
              req.conditions.map((c, i) => (
                <div key={i} className={styles.fact}><dt className={styles.factKey}>{c.label}</dt><dd className={styles.factVal} data-tone="info">{c.progressText}</dd></div>
              ))
            ) : (
              <>
                <div className={styles.fact}><dt className={styles.factKey}>Mở khóa bằng</dt><dd className={styles.factVal}>{req.single.unlockRequirement}</dd></div>
                <div className={styles.fact}><dt className={styles.factKey}>Tiến độ</dt><dd className={styles.factVal} data-tone="info">{req.single.progressText}</dd></div>
                <div className={styles.fact}><dt className={styles.factKey}>Còn thiếu</dt><dd className={styles.factVal} data-tone="warn">{req.single.remainingText}</dd></div>
              </>
            )}
            {!owned && frame.progress?.status === 'PROGRESSING' && (
              <span className={styles.meter} aria-hidden="true"><span style={{ width: `${Math.min(100, frame.progress?.percent ?? 0)}%` }} /></span>
            )}
          </dl>
          <div className={styles.showcaseActions}>
            {equipped ? (
              <button type="button" className={styles.btnGhost} disabled={busy} onClick={onUnequip}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Tháo khung
              </button>
            ) : owned ? (
              <button type="button" className={styles.btn} disabled={busy} onClick={() => onEquip(frame.slug)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}Trang bị
              </button>
            ) : (
              <span className={`${styles.btnGhost} ${styles.mutedBtn}`} aria-disabled="true">
                {frame.progress?.status === 'ELIGIBLE' ? 'Đủ điều kiện mở khóa' : 'Chưa đủ điều kiện'}
              </span>
            )}
          </div>
          {message && (
            <p className={styles.note} data-kind={message.type === 'success' ? 'ok' : 'error'} role={message.type === 'success' ? 'status' : 'alert'}>
              {message.type === 'success' ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
              {message.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
