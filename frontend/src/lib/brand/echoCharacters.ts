import { ECHO_ART } from './echoArt';

/**
 * The one registry of Echo pictures (owner brief 2026-10-31, 10 §BJ). A component asks for a role and the size it draws; it never holds a path.
 *
 *   official  the owner's blue whale: the product's mark (favicon, app icons, sidebar, landing, sign-in, system notices, the small AI action icon)
 *   scholar   round glasses and a book: study help (Reading explanations, Writing feedback, Listening import)
 *   social    headset and a smile: conversation (Echo Coach and the floating companion, Speaking, Community's official voice)
 *   tech      headphones and a laptop: games and machine opponents (Echo as a game bot)
 *
 * Never for: a learner's avatar, lesson pictures, game worlds, the 3D whale model.
 */
export type EchoRole = 'official' | 'scholar' | 'social' | 'tech';

export function echoSrc(role: EchoRole = 'official', drawnPx = 64): string {
  if (role === 'official') {
    const art = ECHO_ART.official;
    return drawnPx <= 32 ? art[64] : drawnPx <= 64 ? art[128] : drawnPx <= 128 ? art[256] : art[512];
  }
  const art = ECHO_ART[role];
  // A whole character with its props does not read small: small sizes get its bust, a complete figure of its own (nothing cropped, nothing to contain).
  return drawnPx <= 44 ? art.face : drawnPx <= 96 ? art[192] : art[384];
}
