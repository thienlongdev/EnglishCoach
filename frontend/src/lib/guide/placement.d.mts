export interface Box { x: number; y: number; w: number; h: number }
export type CardSide = 'top' | 'bottom' | 'left' | 'right' | 'center';
export function overlapArea(a: Box, b: Box): number;
export function placeCard(hole: Box | null, card: { w: number; h: number }, view: { w: number; h: number }, prefer?: 'auto' | 'top' | 'bottom' | 'left' | 'right'): { x: number; y: number; side: CardSide };
export function placeEcho(cardBox: Box, hole: Box | null, size: number, view: { w: number; h: number }): { x: number; y: number; onTarget: boolean; facesLeft: boolean };
export function holeOf(rect: { left: number; top: number; right: number; bottom: number }, pad: number, radius: number, view: { w: number; h: number }): Box & { r: number };
export function liquidPath(l: number, t: number, r: number, b: number, radius: number, bow?: { top: number; right: number; bottom: number; left: number }): string;
