import { WARDROBE, FABRICS, type WardrobeItem } from './wardrobeAssets';

/**
 * What a player wears, as data every 3D place understands: Study Space, Speaking Arena and Echo Quiz Rush read the same record.
 * `signature` is the cast's own tailoring (the look the characters were designed in). No accessory is ever worn by default.
 */
export type Hero = 'LYRA' | 'KAI';
export interface AvatarLook {
  top: string;
  bottom: string;
  shoes: string;
  accessories: string[];
  outerwear?: string;
  colors: { top: string; bottom: string; shoes: string; hair: string; accessory: string };
}
export interface AvatarIdentity { hero: Hero; look: AvatarLook; at: number }

export const SIGNATURE = 'signature';

/** True when a full-body coat or cardigan is worn over base garments (requires modular base instead of `Runner_Body`). */
export function hasLayeredCoat(look: { outerwear?: string | null }): boolean {
  return Boolean(
    look.outerwear &&
    look.outerwear !== 'none' &&
    look.outerwear !== 'winter_scarf',
  );
}
export const COLOR_SWATCHES = {
  top: ['#f2efe9', '#2f3a55', '#6d84b4', '#c75b6a', '#e8b65e', '#4f8a6b', '#8d6fb8', '#2b2b30'],
  bottom: ['#2c3e5e', '#54657f', '#37383f', '#b49a78', '#6f5a4a', '#3f6152', '#e6e2d8', '#7d4a55'],
  shoes: ['#f2efe6', '#2b2b30', '#8a5a3b', '#5a6d8c', '#b0413e', '#d8c7a8'],
  hair: ['#2b1d16', '#40303f', '#5a3a2a', '#8a5a3b', '#c99a5e', '#3b4a8a', '#7c6cf0', '#a8485f'],
  accessory: ['#3b3f55', '#e9ecfb', '#2f3a55', '#c75b6a', '#4f8a6b', '#e8b65e'],
} as const;
const HAIR_DEFAULT: Record<Hero, string> = { LYRA: '#40303f', KAI: '#3a2a22' };

export const defaultLook = (hero: Hero): AvatarLook => ({
  top: SIGNATURE, bottom: SIGNATURE, shoes: SIGNATURE, accessories: [],
  colors: { top: '#2f3a55', bottom: '#2c3e5e', shoes: '#f2efe6', hair: HAIR_DEFAULT[hero], accessory: '#3b3f55' },
});

export const itemsOf = (hero: Hero) => WARDROBE[hero].items;
export function slotItems(hero: Hero, slot: WardrobeItem['slot']): WardrobeItem[] { return Object.values(itemsOf(hero)).filter(i => i.slot === slot); }
const hex = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;

/** Whatever came in (a saved layout, a network message), what goes out is something this hero can wear. */
export function normalizeLook(hero: Hero, raw: unknown): AvatarLook {
  const d = defaultLook(hero), v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = itemsOf(hero);
  const pick = (value: unknown, slots: WardrobeItem['slot'][], fallback: string) => typeof value === 'string' && items[value] && slots.includes(items[value].slot) ? value : fallback;
  const outerwear = typeof v.outerwear === 'string' && v.outerwear.length > 0 && v.outerwear !== 'none' ? v.outerwear : undefined;
  const wearingCoat = hasLayeredCoat({ outerwear });
  let top = pick(v.top, ['top', 'dress'], SIGNATURE), bottom = pick(v.bottom, ['bottom'], SIGNATURE), shoes = pick(v.shoes, ['shoes'], SIGNATURE);
  // A garment needs the rest of an outfit: a shirt or coat with `Runner_Body` underneath would poke through.
  if (top === SIGNATURE && (wearingCoat || bottom !== SIGNATURE || shoes !== SIGNATURE)) {
    top = wearingCoat && items.knit ? 'knit' : (slotItems(hero, 'top')[0]?.id ?? SIGNATURE);
  }
  if (top !== SIGNATURE && items[top].slot !== 'dress' && bottom === SIGNATURE) {
    bottom = wearingCoat && items.chinos ? 'chinos' : (slotItems(hero, 'bottom')[0]?.id ?? SIGNATURE);
  }
  if (top !== SIGNATURE && shoes === SIGNATURE) {
    shoes =
      wearingCoat && (outerwear === 'wool_overcoat' || outerwear === 'puffer_parka') && items.boots
        ? 'boots'
        : wearingCoat && outerwear === 'trench_coat' && items.loafers
          ? 'loafers'
          : (slotItems(hero, 'shoes')[0]?.id ?? SIGNATURE);
  }
  if (top !== SIGNATURE && items[top]?.slot === 'dress') bottom = SIGNATURE;
  const accessories = Array.isArray(v.accessories) ? [...new Set(v.accessories.filter((a): a is string => typeof a === 'string' && items[a]?.slot === 'accessory'))] : [];
  const c = (v.colors && typeof v.colors === 'object' ? v.colors : {}) as Record<string, unknown>;
  return {
    top,
    bottom,
    shoes,
    accessories,
    ...(outerwear ? { outerwear } : {}),
    colors: { top: hex(c.top, d.colors.top), bottom: hex(c.bottom, d.colors.bottom), shoes: hex(c.shoes, d.colors.shoes), hair: hex(c.hair, d.colors.hair), accessory: hex(c.accessory, d.colors.accessory) },
  };
}

export const isSignature = (look: AvatarLook) =>
  !hasLayeredCoat(look) && look.top === SIGNATURE && look.bottom === SIGNATURE && look.shoes === SIGNATURE;

/** Every file this look needs: nothing else is fetched. */
export function lookFiles(hero: Hero, look: AvatarLook): WardrobeItem[] {
  const items = itemsOf(hero), out: WardrobeItem[] = [];
  if (!isSignature(look)) {
    out.push(items.skin);
    for (const id of [look.top, look.bottom, look.shoes]) if (id !== SIGNATURE && items[id]) out.push(items[id]);
  }
  for (const id of look.accessories) if (items[id]) out.push(items[id]);
  return out;
}

/** Compact form for a room message. The server keeps it as an opaque, checked string and never reads a URL or a model out of it. */
export function encodeLook(look: AvatarLook): string {
  const c = look.colors, strip = (x: string) => x.slice(1);
  return [look.top, look.bottom, look.shoes, look.accessories.join('+') || '-', strip(c.top), strip(c.bottom), strip(c.shoes), strip(c.hair), strip(c.accessory)].join('.');
}
export function decodeLook(hero: Hero, wire: string | null | undefined): AvatarLook {
  if (!wire) return defaultLook(hero);
  if (wire.startsWith('v2:') && wire.length <= 256) {
    const colonParts = wire.split(':');
    if (colonParts.length === 8) {
      const o = colonParts[7].split('.');
      if (o.length === 12) {
        return normalizeLook(hero, {
          outerwear: o[0],
          top: o[1],
          bottom: o[2],
          shoes: o[3],
          accessories: o[4] === '-' ? [] : o[4].split(/[-+]/),
          colors: {
            top: '#' + o[6],
            bottom: '#' + o[7],
            shoes: '#' + o[8],
            hair: '#' + o[9],
            accessory: '#' + o[10],
          },
        });
      }
    }
    return defaultLook(hero);
  }
  if (wire.length > 96) return defaultLook(hero);
  const p = wire.split('.');
  if (p.length !== 9) return defaultLook(hero);
  return normalizeLook(hero, { top: p[0], bottom: p[1], shoes: p[2], accessories: p[3] === '-' ? [] : p[3].split('+'), colors: { top: '#' + p[4], bottom: '#' + p[5], shoes: '#' + p[6], hair: '#' + p[7], accessory: '#' + p[8] } });
}

/** At least this many full outfits for each hero: the test holds the wardrobe to it. */
export function outfitCount(hero: Hero) {
  const tops = slotItems(hero, 'top').length, bottoms = slotItems(hero, 'bottom').length, dresses = slotItems(hero, 'dress').length;
  return tops * bottoms + dresses;
}
export { FABRICS };
