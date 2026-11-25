'use client';

import React, { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { accountOfKey, appearanceLabel, currentAppearance, restoreDefaultAppearance } from '@/lib/appearance/state';
import { findSpatialPreset } from '@/lib/spatial/catalog';
import { spatialKey, subscribeSpatial } from '@/lib/spatial/preference';
import { findPreset } from '@/lib/wallpaper/catalog';
import { accountKey, subscribePreference } from '@/lib/wallpaper/storage';
import { findWorld } from '@/lib/wallpaper/worlds/catalog';
import { resolveActiveBgConfig, subscribeBgState, subscribeLiveWorkspacePreview } from '@/lib/background-studio/store';
import styles from './StudioBar.module.css';
import { useOverlayTitle } from '@/lib/brand/tabTitle';

export type StudioRoom = 'media' | 'background' | 'worlds' | 'spatial' | 'navigation';

/**
 * The one header of the Giao diện dialog, the same in all rooms: where you are, what is really on now, the way back to the normal look, and Close. Moving between rooms is only browsing: it
 * changes nothing on the page (10 §BI).
 */
export default function StudioBar({ room, onRoom, storageKey, vi, closeRef, onClose, disabled, children }: {
  room: StudioRoom;
  onRoom: (room: StudioRoom) => void;
  storageKey: string;
  vi: boolean;
  closeRef?: React.Ref<HTMLButtonElement>;
  onClose: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  useOverlayTitle(
    room === 'spatial'
      ? (vi ? 'Không gian 3D' : '3D Space')
      : room === 'navigation'
        ? (vi ? 'Điều hướng' : 'Navigation')
        : room === 'background'
          ? 'Background'
          : (vi ? 'Giao diện' : 'Appearance'),
  );
  const account = accountOfKey(storageKey);
  const active = useSyncExternalStore(
    (onChange) => {
      const offA = subscribePreference(accountKey(account), onChange);
      const offB = subscribeSpatial(spatialKey(account), onChange);
      const offC = subscribeBgState(account, onChange);
      const offD = subscribeLiveWorkspacePreview(onChange);
      return () => {
        offA();
        offB();
        offC();
        offD();
      };
    },
    () => JSON.stringify(currentAppearance(account)),
    () => '{"mode":"default"}',
  );
  const now = JSON.parse(active) as ReturnType<typeof currentAppearance>;
  const activeBgName = now.mode === 'background' ? resolveActiveBgConfig(account)?.themeName : undefined;
  const name =
    now.mode === 'spatial'
      ? (vi ? findSpatialPreset(now.selectionId)?.titleVi : findSpatialPreset(now.selectionId)?.titleEn)
      : now.mode === 'world'
        ? findWorld(now.selectionId)?.title
        : now.mode === 'wallpaper'
          ? (vi ? findPreset(now.selectionId)?.titleVi : findPreset(now.selectionId)?.titleEn) ?? (vi ? 'Của bạn' : 'Your own')
          : now.mode === 'background'
            ? activeBgName
            : undefined;
  const rooms: [StudioRoom, string][] = [
    ['media', vi ? 'Hình nền' : 'Wallpapers'],
    ['background', 'Background'],
    ['worlds', vi ? 'Thế giới sống' : 'Living worlds'],
    ['spatial', vi ? 'Không gian 3D' : '3D space'],
    ['navigation', vi ? 'Điều hướng' : 'Navigation'],
  ];
  return (
    <header className={styles.bar} data-testid="studio-bar">
      <div className={styles.rooms} role="tablist" aria-label={vi ? 'Giao diện' : 'Appearance'}>
        {rooms.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={room === id} className={`${styles.room} ${room === id ? styles.roomOn : ''}`} disabled={disabled && room !== id} onClick={() => onRoom(id)} data-testid={`studio-room-${id}`}>
            {label}
          </button>
        ))}
      </div>
      <p className={styles.now} data-testid="appearance-active" data-mode={now.mode} data-selection={now.mode === 'default' ? '' : now.selectionId}>
        <span className={styles.nowDot} data-on={now.mode !== 'default' || undefined} aria-hidden="true" />
        <span>{vi ? 'Đang dùng' : 'In use'}: <strong>{appearanceLabel(now, vi)}</strong>{name ? ` · ${name}` : ''}</span>
      </p>
      <div className={styles.actions}>
        {children}
        <button
          type="button"
          className={styles.action}
          disabled={disabled || now.mode === 'default'}
          onClick={() => {
            restoreDefaultAppearance(account);
            onClose();
          }}
          data-testid="appearance-default"
        >
          {vi ? 'Về giao diện thường' : 'Back to normal'}
        </button>
        <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'} data-testid="studio-close">
          <X className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
