'use client';
import { useSyncExternalStore } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { setVfxPreference, subscribeVfx, vfxPreference, VFX_PRESETS, type VfxPreset } from '@/lib/vfx/quality';
export default function VfxSettings({compact=false,bare=false}:{compact?:boolean;bare?:boolean}) {
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const value = useSyncExternalStore(subscribeVfx, vfxPreference, () => 'auto' as const);
  const labels = vi ? ['Tự động', 'Cực cao', 'Cao', 'Vừa', 'Nhẹ'] : ['Auto', 'Ultra', 'High', 'Medium', 'Low'];
  return <label style={bare ? undefined : { display: 'grid', gap: 6, fontSize: 13 }}>
    {compact ? (vi ? 'Hiệu ứng' : 'Effects') : (vi ? 'Hiệu ứng điện ảnh' : 'Cinematic effects')}
    <select aria-label={vi ? 'Chất lượng hiệu ứng điện ảnh' : 'Cinematic effects quality'} value={value} onChange={e => setVfxPreference(e.target.value as VfxPreset)} style={bare ? undefined : { minHeight: 44, borderRadius: 12, padding: '8px 12px', color: 'rgb(var(--foreground))', background: 'rgb(var(--surface))', border: '1px solid #7895a866' }}>
      {VFX_PRESETS.map((p, i) => <option key={p} value={p}>{labels[i]}</option>)}
    </select>
    {!compact&&<small>{vi ? 'Tự giảm khi máy chậm. Tôn trọng Giảm chuyển động của thiết bị.' : 'Adapts when frames slow. Respects device reduced motion.'}</small>}
  </label>;
}
