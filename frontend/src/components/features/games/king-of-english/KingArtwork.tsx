import type { KingMode } from './domain';
import { KING_ART, KING_MODE_ART } from './kingArt';

/**
 * King Of English pictures: the Games Hub poster (no `mode`) or one game mode's world. Original Blender renders built from code
 * (`docs/king-of-english/royal-rebirth-2026-10-25/art/`), content-hashed names, fixed intrinsic size (no layout shift).
 */
export function KingArtwork({ mode, className = '', eager = false }: { mode?: KingMode; className?: string; eager?: boolean }) {
  const src = mode ? KING_MODE_ART[mode] : KING_ART.keyArt;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" aria-hidden="true" width={mode ? 720 : 1672} height={mode ? 900 : 941} decoding="async"
    loading={eager ? 'eager' : 'lazy'} className={`block select-none ${className}`} draggable={false} />;
}
