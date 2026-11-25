/** Call synchronously inside the initiating gesture, before audio/network awaits. */
export function enterRushFullscreen() {
  if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
}
export function leaveRushFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
}
