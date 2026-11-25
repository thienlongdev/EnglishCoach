'use client';
import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { Panel } from './panels';
import { useAccount } from './data';
import { ops, useSpace } from '@/lib/study-space/store';
import { accountKey, currentPreference, openWallpaperStudio } from '@/lib/wallpaper/storage';
import { currentSpatial, spatialKey } from '@/lib/spatial/preference';
import { readAppearanceTheme } from '@/lib/appearance/scope';
import s from './studySpace.module.css';

export default function AppearancePanel({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const appearance = useSpace(st => st.layout.appearance);
  const override = !!appearance;
  return <Panel title="Giao diện của không gian" icon={<ImageIcon size={20} />} onClose={onClose} side>
    <div className={s.appearanceOptions}>
      <label className={s.row}><input type="radio" name="space-appearance" checked={!override} onChange={() => useSpace.getState().apply(l => ({ ...l, appearance: undefined }))} />
        <span><b>Theo giao diện website</b><small>Dùng lựa chọn chung của English Coach.</small></span></label>
      <label className={s.row}><input type="radio" name="space-appearance" checked={override} onChange={() => useSpace.getState().apply(l => ({ ...l, appearance: { mode: 'override', wallpaper: currentPreference(accountKey(account)), spatial: currentSpatial(spatialKey(account)), theme: readAppearanceTheme() } }))} />
        <span><b>Giao diện riêng của không gian này</b><small>Lưu cùng không gian, không đổi giao diện website.</small></span></label>
      <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => { onClose(); openWallpaperStudio(); }}>Chọn trong Giao diện</button>
      <p className={s.hint}>{override ? 'Hình nền, video, Thế giới sống, Không gian 3D và màu sáng/tối bạn chọn sẽ chỉ áp dụng ở đây.' : 'Lựa chọn tiếp theo sẽ đổi giao diện chung của website.'}</p>
      <p className={s.hint}>Xóa trắng chỉ dọn nội thất và công cụ. Khung cảnh nền được giữ nguyên.</p>
    </div>
  </Panel>;
}
