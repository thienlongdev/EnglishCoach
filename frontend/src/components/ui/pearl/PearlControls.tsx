'use client';
/** Echo Pearl Glass controls shared by Vũ trụ tri thức and Echo Odyssey: a real switch and a real segmented choice (both are
 *  native buttons with ARIA roles; every control changes real state, nothing decorative). */
import type { ReactNode } from 'react';
import pg from './pearlGlass.module.css';

export function PearlSwitch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return <button type="button" id={id} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={pg.switch} onClick={() => onChange(!checked)} />;
}

export function PearlSegmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string }) {
  const move = (dir: number, el: HTMLElement) => {
    const i = options.findIndex(o => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => (el.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
  };
  return (
    <div className={pg.segmented} role="radiogroup" aria-label={label}
      onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1, e.currentTarget); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1, e.currentTarget); } }}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} title={o.title}
          className={pg.segment} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
