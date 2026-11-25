'use client';

import { useEffect, useState } from 'react';
import { decodeLook, encodeLook, normalizeLook } from '@/lib/avatar/look';
import { isRushHero, type RushHero } from './sky/skyCharacter';

/**
 * The hero choice (cosmetic only: one skeleton, one collision body, the same physics). Each card shows the body that really
 * races: the cast of the Study Space and the Arena, drawn in the browser from its current model and in the clothes the player
 * chose there (`sky/rushPortrait.ts`). The 3D lobby behind the cards plays the chosen hero live. The choice is a per-browser
 * preference — every Solo, Bots, Quick Match and private-room request carries it.
 */
const STORAGE = 'echo-quiz-rush:hero-v1';
export function savedHero(): RushHero {
  try { const v = localStorage.getItem(STORAGE); return isRushHero(v) ? v : 'LYRA'; } catch { return 'LYRA'; }
}
export function useRushHero(): [RushHero, (hero: RushHero) => void] {
  const [hero, setHero] = useState<RushHero>('LYRA');
  useEffect(() => { setHero(savedHero()); }, []);
  const choose = (value: RushHero) => { setHero(value); try { localStorage.setItem(STORAGE, value); } catch { /* private mode */ } };
  return [hero, choose];
}

const CARDS: { id: RushHero; name: string; vi: string; en: string }[] = [
  { id: 'LYRA', name: 'Lyra', vi: 'Nhà thám hiểm tóc đuôi ngựa', en: 'Ponytailed explorer' },
  { id: 'KAI', name: 'Kai', vi: 'Nhà thám hiểm tóc rối', en: 'Tousled-hair explorer' },
];

/** The outfit each card wears: the player's own on their hero, the same pieces on the other where that hero has them. */
const outfitFor = (card: RushHero, hero: RushHero, avatar: string) => card === hero ? avatar : encodeLook(normalizeLook(card, decodeLook(hero, avatar)));

export function RushHeroPicker({ vi, hero, onChange, compact = false, avatar = '' }: { vi: boolean; hero: RushHero; onChange: (hero: RushHero) => void; compact?: boolean; avatar?: string }) {
  const [art, setArt] = useState<Partial<Record<RushHero, string | null>>>({});
  const outfits = CARDS.map(c => outfitFor(c.id, hero, avatar)).join('|');
  useEffect(() => {
    let live = true;
    void import('./sky/rushPortrait').then(({ heroPortrait }) => {
      for (const c of CARDS) void heroPortrait(c.id, outfitFor(c.id, hero, avatar)).then(url => { if (live) setArt(a => ({ ...a, [c.id]: url })); });
    }).catch(() => { if (live) setArt({ LYRA: null, KAI: null }); });
    return () => { live = false; };
    // The outfits string carries everything the portraits depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outfits]);
  return <fieldset className={`rush-heroes${compact ? ' is-compact' : ''}`} data-testid="rush-hero-picker">
    <legend>{vi ? 'Nhân vật' : 'Your hero'}</legend>
    <div role="radiogroup" aria-label={vi ? 'Chọn nhân vật' : 'Choose your hero'}>
      {CARDS.map(c => {
        const src = art[c.id];
        return <button key={c.id} type="button" role="radio" aria-checked={hero === c.id} data-hero={c.id} className="rush-hero-card" onClick={() => onChange(c.id)}>
          {src ? <img src={src} alt="" width={160} height={215} decoding="async" data-portrait="cast" />
            : <span className="rush-hero-portrait" data-state={src === null ? 'none' : 'drawing'} aria-hidden="true">{src === null ? c.name.slice(0, 1) : null}</span>}
          <b>{c.name}</b><small>{vi ? c.vi : c.en}</small>
        </button>;
      })}
    </div>
    {!compact && <p className="rush-hero-note">{vi ? 'Chỉ khác ngoại hình — tốc độ, cú nhảy và va chạm như nhau.' : 'Looks only — speed, jumps and collisions are identical.'}</p>}
  </fieldset>;
}
