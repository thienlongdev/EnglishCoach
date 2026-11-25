'use client';
import { useEffect, useState } from 'react';
import { defaultLook, encodeLook, normalizeLook, type AvatarIdentity, type AvatarLook, type Hero } from './look';
import {
  createDefaultCreatorProfile,
  decodeLookV2,
  encodeLookV2,
  profileToAvatarLook,
  sanitizeCreatorProfile,
  type CharacterCreatorProfile,
  type OutfitSlotId,
} from './characterCreator';

/**
 * One player, one appearance. The Study Space layout on the server is where the choice is kept; this per-account browser record is what lets
 * Speaking Arena and Echo Quiz Rush know it at once. It holds nothing but the choice, under the account's own key, and goes with sign-out.
 * On a new device the first read fills it from the active Study Space.
 */
const key = (account: string) => `ec_avatar:v1:u${account}`;
const keyV2 = (account: string) => `ec_avatar:v2:u${account}`;
const isHero = (v: unknown): v is Hero => v === 'LYRA' || v === 'KAI';

export function readIdentity(account: string | null | undefined): AvatarIdentity | null {
  if (!account) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(key(account)) || 'null') as { hero?: unknown; look?: unknown; at?: unknown } | null;
    if (!raw || !isHero(raw.hero)) return null;
    return { hero: raw.hero, look: normalizeLook(raw.hero, raw.look), at: typeof raw.at === 'number' ? raw.at : 0 };
  } catch { return null; }
}
export function writeIdentity(account: string | null | undefined, identity: AvatarIdentity) {
  if (!account) return;
  try { localStorage.setItem(key(account), JSON.stringify(identity)); } catch { /* this visit still has it */ }
  window.dispatchEvent(new CustomEvent('ec:avatar', { detail: identity }));
}
export const identityWire = (identity: AvatarIdentity | null) => identity ? encodeLook(identity.look) : '';

/** Reads the per-account Wave 11 Character Creator V2 profile (`ec_avatar:v2:u${account}`), gracefully upgrading V1 if absent. */
export function readCreatorProfile(account: string | null | undefined): CharacterCreatorProfile | null {
  if (!account) return null;
  try {
    const rawStr = localStorage.getItem(keyV2(account));
    if (rawStr) {
      const parsed = JSON.parse(rawStr) as unknown;
      if (parsed && typeof parsed === 'object') {
        const heroHint = isHero((parsed as { hero?: unknown }).hero) ? (parsed as { hero: Hero }).hero : 'LYRA';
        return sanitizeCreatorProfile(parsed, heroHint);
      }
    }
  } catch { /* fall through to legacy V1 upgrade */ }
  const legacy = readIdentity(account);
  if (!legacy) return null;
  return decodeLookV2(encodeLook(legacy.look), legacy.hero);
}

/** Persists the per-account Character Creator V2 profile alongside legacy V1 identity and emits `ec:avatar` + `ec:avatar-v2`. */
export function writeCreatorProfile(
  account: string | null | undefined,
  profile: CharacterCreatorProfile,
): CharacterCreatorProfile {
  const safe = sanitizeCreatorProfile(profile, profile.hero);
  if (!account) return safe;
  const legacy: AvatarIdentity = {
    hero: safe.hero,
    look: profileToAvatarLook(safe),
    at: Date.now(),
  };
  try {
    localStorage.setItem(keyV2(account), JSON.stringify(safe));
    localStorage.setItem(key(account), JSON.stringify(legacy));
  } catch { /* this visit still holds it in memory */ }
  window.dispatchEvent(new CustomEvent('ec:avatar', { detail: legacy }));
  window.dispatchEvent(new CustomEvent('ec:avatar-v2', { detail: safe }));
  return safe;
}

export const creatorProfileWire = (profile: CharacterCreatorProfile | null, slotId?: OutfitSlotId): string =>
  profile ? encodeLookV2(profile, slotId) : '';

/** Subscribes to per-account Character Creator V2 profile updates across Echo Life / Study Space UI panels. */
export function useCreatorProfile(
  account: string | null | undefined,
  defaultHero: Hero = 'LYRA',
): CharacterCreatorProfile {
  const [profile, setProfile] = useState<CharacterCreatorProfile>(() => createDefaultCreatorProfile(defaultHero));
  useEffect(() => {
    if (!account) return;
    const saved = readCreatorProfile(account);
    if (saved) setProfile(saved);
    const onV2 = (e: Event) => {
      const detail = (e as CustomEvent<CharacterCreatorProfile>).detail;
      if (detail) setProfile(sanitizeCreatorProfile(detail, detail.hero));
    };
    window.addEventListener('ec:avatar-v2', onV2);
    return () => window.removeEventListener('ec:avatar-v2', onV2);
  }, [account]);
  return profile;
}

/** For a place outside the Study Space. The read from the server happens only when this browser has no record of the choice. */
export function useAvatarIdentity(account: string | null | undefined, fetchActive?: () => Promise<{ model?: unknown; look?: unknown; lookAt?: unknown } | null>): AvatarIdentity {
  const fallback: AvatarIdentity = { hero: 'LYRA', look: defaultLook('LYRA'), at: 0 };
  const [identity, setIdentity] = useState<AvatarIdentity>(fallback);
  useEffect(() => {
    if (!account) return;
    const local = readIdentity(account);
    if (local) setIdentity(local);
    else if (fetchActive) void fetchActive().then(ch => {
      if (!ch || !isHero(ch.model)) return;
      const next: AvatarIdentity = { hero: ch.model, look: normalizeLook(ch.model, ch.look), at: typeof ch.lookAt === 'number' ? ch.lookAt : 1 };
      writeIdentity(account, next); setIdentity(next);
    }).catch(() => undefined);
    const on = (e: Event) => setIdentity((e as CustomEvent<AvatarIdentity>).detail);
    window.addEventListener('ec:avatar', on);
    return () => window.removeEventListener('ec:avatar', on);
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps
  return identity;
}
export type { AvatarIdentity, AvatarLook, Hero, CharacterCreatorProfile };
