/**
 * What a sign-in form tells Echo. Since the Echo Glass sign-in world (2026-10-22) the mood moves the real Echo of the scene
 * (`AuthScene`, `data-mood`); the small SVG mascot that used to peek over the card is gone.
 */
export type MascotState =
  | 'idle'
  | 'email-focus'
  | 'password-focus'
  | 'password-visible'
  | 'submitting'
  | 'success'
  | 'error';
