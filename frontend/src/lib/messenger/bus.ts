import type { MessengerEvent } from '@/types/messenger';

/**
 * The private queue arrives on the one socket every signed-in page holds (NotificationRealtimeContext). This is the wire between that socket and the Messenger, so the
 * main bundle carries none of the Messenger itself and there is never a second socket.
 */
type Listener = (event: MessengerEvent) => void;
const listeners = new Set<Listener>();
let publisher: ((destination: string, body: string) => void) | null = null;

export const onMessenger = (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const emitMessenger = (event: MessengerEvent) => { for (const fn of listeners) fn(event); };
export const setMessengerPublisher = (fn: ((destination: string, body: string) => void) | null) => { publisher = fn; };
export const publishTyping = (conversationId: string) => publisher?.('/app/messenger/typing', JSON.stringify({ conversationId }));

/** Two ways in that depend on where the person is. In the room the body gets up and walks to the door; the room says so by cancelling the event. */
export function requestArenaJoin(code: string, fallback: (href: string) => void) {
  const event = new CustomEvent('ec:arena-join', { cancelable: true, detail: { code } });
  if (window.dispatchEvent(event)) fallback(`/speaking/arena?join=${encodeURIComponent(code)}`);
}
export function requestOpenMessenger(conversationId: string | null, fallback: (href: string) => void) {
  const event = new CustomEvent('ec:messenger-open', { cancelable: true, detail: { conversationId } });
  if (window.dispatchEvent(event)) fallback(conversationId ? `/community/messages?c=${encodeURIComponent(conversationId)}` : '/community/messages');
}
