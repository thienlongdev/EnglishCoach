import { create } from 'zustand';
import { messengerApi } from '@/services/messengerApi';
import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import { onMessenger } from './bus';
import type { ArenaInvite, Attachment, ChatMessage, Conversation, ConversationSettings, InviteMode, ListScope, Mention, MessengerEvent, MessengerPeople, MessengerPerson, Reaction } from '@/types/messenger';

/**
 * One state for every place the Messenger is shown: the page, the laptop, the desktop PC and the small cards. The server keeps the conversations; this keeps what is on screen
 * and moves it by the private queue. It belongs to one account and is emptied at the account boundary.
 *
 * A signed-in page that is not showing the Messenger costs one small question when it loads (three numbers for the badge) and nothing after that: the lists are only fetched
 * while a Messenger is open, nothing polls, and a burst of reconnects after a release spreads itself out.
 */
export interface Thread { messages: ChatMessage[]; more: boolean; loading: boolean; loaded: boolean; error: boolean }
export type MessengerView = 'chats' | 'friends' | 'requests' | 'search';
export type Card =
  | { key: string; kind: 'message'; conversationId: string; name: string; text: string; at: number }
  | { key: string; kind: 'invite'; conversationId: string; name: string; invite: ArenaInvite; at: number }
  | { key: string; kind: 'accepted'; conversationId: string; name: string; invite: ArenaInvite; at: number }
  | { key: string; kind: 'declined'; conversationId: string; name: string; invite: ArenaInvite; at: number }
  | { key: string; kind: 'message-request'; conversationId: string; name: string; at: number }
  | { key: string; kind: 'request-accepted'; conversationId: string; name: string; at: number }
  | { key: string; kind: 'friend-request'; userId: number; name: string; at: number }
  | { key: string; kind: 'friend-accepted'; userId: number; name: string; at: number };

/** A file chosen for a message, prepared on this device: uploaded only when the message is sent. */
export interface PendingFile { key: string; kind: 'IMAGE' | 'FILE'; name: string; mime: string; size: number; blob: Blob; thumb: Blob | null; url: string | null; width: number | null; height: number | null; uploaded?: Attachment }

const EMPTY_PEOPLE: MessengerPeople = { friends: [], incoming: [], outgoing: [], blocked: [], moreFriends: false, restricted: [] };
const uuid = () => (typeof globalThis.crypto?.randomUUID === 'function' ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ (Math.random() * 16) >> Number(c) / 4).toString(16)));
export const errorCode = (e: unknown, fallback = 'UNAVAILABLE') => (e as { response?: { data?: { code?: string } } })?.response?.data?.code ?? fallback;
/** What a list shows for a conversation: the person's name, or the group's. */
export const titleOf = (c: Conversation) => c.kind === 'GROUP' ? (c.title ?? '') : (c.other?.name ?? '');

interface MessengerState {
  me: number;
  ready: boolean;
  listFailed: boolean;
  people: MessengerPeople;
  conversations: Conversation[];
  moreChats: boolean;
  requests: Conversation[];
  /** Conversations kept aside: archived ones, and those of people I restricted. Fetched only when that list is opened. */
  aside: Record<'ARCHIVED' | 'RESTRICTED', Conversation[] | null>;
  threads: Record<string, Thread>;
  typing: Record<string, { until: number; name: string | null }>;
  /** The conversation on screen right now, in a visible Messenger. */
  viewing: string | null;
  cards: Card[];
  unread: number;
  messageRequests: number;
  friendRequests: number;
  /** A view another part of the app asked to see (a card, a link). The Messenger takes it when it is on screen. */
  wantView: MessengerView | null;
  /** The server's clock minus this device's: "active 5 minutes ago" is counted in the server's time. */
  skew: number;
  /** Counts up when something about a conversation itself changed (people, name, theme): whoever shows its details reads them again. */
  rev: Record<string, number>;
  bind(me: number): void;
  boot(): Promise<void>;
  /** A Messenger is on screen: its lists are fetched and kept moving until it is gone. */
  attach(): () => void;
  load(): Promise<void>;
  loadPeople(): Promise<void>;
  loadAside(scope: 'ARCHIVED' | 'RESTRICTED'): Promise<void>;
  moreConversations(): Promise<void>;
  moreFriends(): Promise<void>;
  open(id: string): Promise<void>;
  older(id: string): Promise<void>;
  /** Loads back as far as a message (the one a reply answers). False: it is too far back, or no longer there. */
  reach(id: string, messageId: number): Promise<boolean>;
  view(id: string | null): void;
  markRead(id: string): void;
  send(id: string, body: string, retryRef?: string, extra?: { replyTo?: ChatMessage | null; files?: PendingFile[]; mentions?: Mention[] }): Promise<void>;
  share(id: string, kind: 'READING' | 'DECK', targetId: number): Promise<void>;
  invite(id: string, mode: InviteMode): Promise<string | null>;
  answer(invite: ArenaInvite, answer: 'accept' | 'decline' | 'cancel'): Promise<ArenaInvite | null>;
  answerRequest(id: string, answer: 'accept' | 'decline'): Promise<void>;
  startWith(userId: number): Promise<string>;
  /** My emoji on a message; null takes it off. Shown at once, put back if the server refuses. */
  react(message: ChatMessage, emoji: string | null): Promise<void>;
  unsend(message: ChatMessage): Promise<void>;
  configure(id: string, patch: ConversationSettings): Promise<void>;
  adopt(conversation: Conversation): void;
  askView(view: MessengerView | null): void;
  dismiss(key: string): void;
  handle(event: MessengerEvent): void;
}

const upsert = (list: ChatMessage[], m: ChatMessage) => {
  const at = list.findIndex(x => x.ref === m.ref || x.id === m.id);
  if (at >= 0) { const next = [...list]; next[at] = m; return next; }
  // In the order the server gave them; things still sending stay at the end.
  const next = [...list, m];
  return next.sort((a, b) => (a.sending ? 1 : 0) - (b.sending ? 1 : 0) || a.id - b.id);
};
const setInvite = (list: ChatMessage[], invite: ArenaInvite) => list.map(m => m.invite?.id === invite.id ? { ...m, invite } : m);
/** One emoji per person per message: mine moves from wherever it was to the new one. */
const withMine = (reactions: Reaction[] | undefined, emoji: string | null): Reaction[] => {
  const out = (reactions ?? []).map(r => r.mine ? { ...r, count: r.count - 1, mine: false } : r).filter(r => r.count > 0);
  if (!emoji) return out;
  const at = out.findIndex(r => r.emoji === emoji);
  if (at >= 0) { out[at] = { ...out[at], count: out[at].count + 1, mine: true }; return out; }
  return [...out, { emoji, count: 1, mine: true }];
};
const unsent = (m: ChatMessage): ChatMessage => ({ ...m, body: '', payload: null, attachments: [], reactions: m.reactions, deleted: true });
export const previewOf = (m: ChatMessage, vi: boolean) => {
  if (m.deleted) return vi ? 'Tin nhắn đã được thu hồi' : 'Message unsent';
  if (m.kind === 'ARENA_INVITE') return vi ? 'Lời mời Speaking Arena' : 'Speaking Arena invitation';
  if (m.kind === 'SHARE_READING') return vi ? `Bài đọc: ${m.body}` : `Reading: ${m.body}`;
  if (m.kind === 'SHARE_DECK') return vi ? `Bộ thẻ: ${m.body}` : `Deck: ${m.body}`;
  const att = m.payload?.att ?? (m.attachments?.length ? { images: m.attachments.filter(a => a.kind === 'IMAGE').length, files: m.attachments.filter(a => a.kind === 'FILE').length } : null);
  if (m.body) return m.body;
  if (att) return att.images && !att.files ? (vi ? (att.images > 1 ? `${att.images} ảnh` : 'Ảnh') : (att.images > 1 ? `${att.images} photos` : 'Photo')) : (vi ? 'Tệp đính kèm' : 'Attachment');
  return '';
};

let attached = 0, askedAt = Date.now();
let listTimer: ReturnType<typeof setTimeout> | null = null, summaryTimer: ReturnType<typeof setTimeout> | null = null;
/** Reading a burst of messages tells the server once. */
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
const readUpTo = new Map<string, number>();
/** The files of a message still on its way, by the message's reference: a retry sends the same files and never uploads one twice. */
const outbox = new Map<string, PendingFile[]>();
/** The "@" mentions of a message on its way, kept for a retry like its files. */
const named = new Map<string, Mention[]>();
const refreshTimers = new Map<number, ReturnType<typeof setTimeout>>();

const EMPTY_MESSENGER_STATE = {
  me: 0,
  ready: false,
  listFailed: false,
  people: EMPTY_PEOPLE,
  conversations: [] as Conversation[],
  moreChats: false,
  requests: [] as Conversation[],
  aside: { ARCHIVED: null, RESTRICTED: null } as Record<'ARCHIVED' | 'RESTRICTED', Conversation[] | null>,
  threads: {} as Record<string, Thread>,
  typing: {} as Record<string, { until: number; name: string | null }>,
  viewing: null as string | null,
  cards: [] as Card[],
  unread: 0,
  messageRequests: 0,
  friendRequests: 0,
  wantView: null as MessengerView | null,
  skew: 0,
  rev: {} as Record<string, number>,
};

function clearMessengerPendingBuffers() {
  if (listTimer) { clearTimeout(listTimer); listTimer = null; }
  if (summaryTimer) { clearTimeout(summaryTimer); summaryTimer = null; }
  readTimers.forEach(clearTimeout); readTimers.clear(); readUpTo.clear();
  refreshTimers.forEach(clearTimeout); refreshTimers.clear();
  outbox.forEach(files => files.forEach(f => {
    if (f.url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(f.url);
  }));
  outbox.clear();
  named.clear();
  askedAt = 0;
}

export const useMessenger = create<MessengerState>((set, get) => {
  const soonSummary = (wait = 900) => {
    if (summaryTimer) return;
    summaryTimer = setTimeout(() => {
      summaryTimer = null;
      void messengerApi.summary().then(n => set({ unread: n.unread, messageRequests: n.messageRequests, friendRequests: n.friendRequests })).catch(() => { /* The next change asks again. */ });
    }, wait);
  };
  const soonLists = (wait = 300) => {
    if (!attached || listTimer) return;
    listTimer = setTimeout(() => { listTimer = null; if (attached) void get().load(); }, wait);
  };
  const everywhere = (st: MessengerState, id: string, change: (c: Conversation) => Conversation) => ({
    conversations: st.conversations.map(c => c.id === id ? change(c) : c),
    requests: st.requests.map(c => c.id === id ? change(c) : c),
    aside: { ARCHIVED: st.aside.ARCHIVED?.map(c => c.id === id ? change(c) : c) ?? null, RESTRICTED: st.aside.RESTRICTED?.map(c => c.id === id ? change(c) : c) ?? null },
  });
  const inThread = (id: string, change: (m: ChatMessage) => ChatMessage) => set(st => st.threads[id] ? { threads: { ...st.threads, [id]: { ...st.threads[id], messages: st.threads[id].messages.map(change) } } } : st);
  /** A message as the server has it now (its emoji, after someone else's changed). One small read, at most once per message in a burst. */
  const refreshMessage = (id: string, messageId: number) => {
    if (refreshTimers.has(messageId)) return;
    refreshTimers.set(messageId, setTimeout(() => {
      refreshTimers.delete(messageId);
      void messengerApi.messages(id, messageId + 1, undefined, messageId).then(page => {
        const fresh = page.messages.find(m => m.id === messageId);
        if (fresh) inThread(id, m => m.id === messageId ? { ...fresh, sending: m.sending, failed: m.failed } : m);
      }).catch(() => { /* Shown as it was; the next open reads it again. */ });
    }, 250));
  };
  return {
    ...EMPTY_MESSENGER_STATE,
    bind(me) {
      const was = get().me;
      if (was === me) return;
      // First sight of the account: a Messenger on screen may already have asked for its lists, which are this same person's. Only another account empties anything.
      if (was === 0) { set({ me }); return; }
      clearMessengerPendingBuffers();
      outbox.clear();
      set({ ...EMPTY_MESSENGER_STATE, me });
    },
    async boot() {
      askedAt = Date.now();
      try {
        const n = await messengerApi.summary();
        set({ unread: n.unread, messageRequests: n.messageRequests, friendRequests: n.friendRequests });
        // A Messenger already on screen fetched its lists a moment ago: something arrived since, and the numbers say so.
        const s = get();
        if (attached && s.ready && (s.requests.length !== n.messageRequests || s.people.incoming.length !== n.friendRequests)) soonLists(0);
      } catch { /* The badge waits for the next change. */ }
    },
    attach() {
      attached += 1;
      if (attached === 1) void get().load();
      return () => { attached = Math.max(0, attached - 1); };
    },
    async load() {
      try {
        const [page, requests, people] = await Promise.all([messengerApi.conversations(), messengerApi.requests(), messengerApi.people()]);
        set(s => ({
          conversations: mergeLocalConversations(s.conversations, page.items), moreChats: page.more, requests, people, ready: true, listFailed: false,
          messageRequests: requests.length, friendRequests: people.incoming.length,
          skew: page.now ? new Date(page.now).getTime() - Date.now() : s.skew,
          // The whole list is here: it is the truth. A longer list keeps the server's own number.
          unread: page.more ? s.unread : page.items.reduce((n, c) => n + c.unread, 0),
        }));
        // A list kept aside that is on screen follows.
        const aside = get().aside;
        if (aside.ARCHIVED) void get().loadAside('ARCHIVED');
        if (aside.RESTRICTED) void get().loadAside('RESTRICTED');
      } catch { set({ listFailed: true, ready: true }); }
    },
    async loadPeople() {
      try {
        const people = await messengerApi.people();
        set({ people, friendRequests: people.incoming.length });
      } catch { /* The list of friends comes again with the next change. */ }
    },
    async loadAside(scope) {
      try {
        const page = await messengerApi.conversations(null, scope as ListScope);
        set(s => ({ aside: { ...s.aside, [scope]: page.items } }));
      } catch { set(s => ({ aside: { ...s.aside, [scope]: s.aside[scope] ?? [] } })); }
    },
    async moreConversations() {
      const s = get(), last = [...s.conversations].reverse().find(c => !c.pinned && c.last)?.last?.at;
      if (!s.moreChats || !last) return;
      try {
        const page = await messengerApi.conversations(last);
        set(st => ({ conversations: [...st.conversations, ...page.items.filter(c => !st.conversations.some(x => x.id === c.id))], moreChats: page.more }));
      } catch { /* The button stays. */ }
    },
    async moreFriends() {
      const s = get();
      if (!s.people.moreFriends) return;
      try {
        const page = await messengerApi.people(s.people.friends.length);
        set(st => ({ people: { ...st.people, friends: [...st.people.friends, ...page.friends.filter(f => !st.people.friends.some(x => x.id === f.id))], moreFriends: page.moreFriends } }));
      } catch { /* The button stays. */ }
    },
    async open(id) {
      const had = get().threads[id];
      set(s => ({ threads: { ...s.threads, [id]: { messages: had?.messages ?? [], more: had?.more ?? false, loading: true, loaded: had?.loaded ?? false, error: false } } }));
      try {
        const page = await messengerApi.messages(id);
        set(s => {
          const local = s.threads[id]?.messages.filter(m => m.sending || m.failed) ?? [];
          return {
            threads: { ...s.threads, [id]: { messages: [...page.messages, ...local.filter(l => !page.messages.some(m => m.ref === l.ref))], more: page.more, loading: false, loaded: true, error: false } },
            ...everywhere(s, id, c => ({ ...c, theirRead: page.theirRead, theirDelivered: page.theirDelivered, myRead: page.myRead })),
          };
        });
        get().markRead(id);
      } catch {
        set(s => ({ threads: { ...s.threads, [id]: { ...(s.threads[id] ?? { messages: [], more: false, loaded: false }), loading: false, error: true } } }));
      }
    },
    async older(id) {
      const t = get().threads[id];
      if (!t || t.loading || !t.more || !t.messages.length) return;
      set(s => ({ threads: { ...s.threads, [id]: { ...t, loading: true } } }));
      try {
        const firstId = t.messages.find(m => !m.sending)?.id;
        const page = await messengerApi.messages(id, firstId);
        set(s => ({ threads: { ...s.threads, [id]: { ...s.threads[id], messages: [...page.messages.filter(m => !s.threads[id].messages.some(x => x.id === m.id)), ...s.threads[id].messages], more: page.more, loading: false } } }));
      } catch { set(s => ({ threads: { ...s.threads, [id]: { ...s.threads[id], loading: false } } })); }
    },
    async reach(id, messageId) {
      const t = get().threads[id];
      if (!t) return false;
      if (t.messages.some(m => m.id === messageId)) return true;
      const firstId = t.messages.find(m => !m.sending)?.id;
      if (!firstId || messageId >= firstId || !t.more) return false;
      try {
        const page = await messengerApi.messages(id, firstId, undefined, messageId);
        if (!page.messages.some(m => m.id === messageId)) return false;
        set(s => ({ threads: { ...s.threads, [id]: { ...s.threads[id], messages: [...page.messages.filter(m => !s.threads[id].messages.some(x => x.id === m.id)), ...s.threads[id].messages], more: page.more } } }));
        return true;
      } catch { return false; }
    },
    view(id) {
      set({ viewing: id });
      if (id) get().markRead(id);
    },
    markRead(id) {
      const s = get(), c = s.conversations.find(x => x.id === id) ?? s.aside.ARCHIVED?.find(x => x.id === id) ?? s.aside.RESTRICTED?.find(x => x.id === id), t = s.threads[id];
      const last = t?.messages.filter(m => !m.sending && !m.failed).at(-1)?.id ?? c?.last?.id;
      if (!last || (c && c.myRead >= last && c.unread === 0 && !c.markedUnread)) return;
      const counted = !!c && s.conversations.includes(c);
      set(st => ({
        ...everywhere(st, id, x => ({ ...x, unread: 0, markedUnread: false, myRead: Math.max(x.myRead, last) })),
        unread: Math.max(0, st.unread - (counted ? c?.unread ?? 0 : 0)),
      }));
      readUpTo.set(id, Math.max(readUpTo.get(id) ?? 0, last));
      if (readTimers.has(id)) return;
      readTimers.set(id, setTimeout(() => {
        readTimers.delete(id);
        const upTo = readUpTo.get(id);
        readUpTo.delete(id);
        if (upTo) void messengerApi.read(id, upTo).catch(() => { /* Read again next time it is opened. */ });
      }, 600));
    },
    async send(id, body, retryRef, extra) {
      const ref = retryRef ?? uuid(), s = get();
      const before = retryRef ? s.threads[id]?.messages.find(m => m.ref === retryRef) : undefined;
      if (extra?.files?.length) outbox.set(ref, extra.files);
      if (extra?.mentions?.length) named.set(ref, extra.mentions);
      const files = outbox.get(ref) ?? [], mentions = named.get(ref) ?? [];
      const reply = extra?.replyTo ?? null;
      const shown = (list: PendingFile[]): Attachment[] => list.map(f => ({ id: f.uploaded?.id ?? f.key, kind: f.kind, name: f.name, mime: f.mime, size: f.size, width: f.width, height: f.height, thumb: false, localUrl: f.url ?? undefined, progress: f.uploaded ? 1 : 0 }));
      const draft: ChatMessage = before ? { ...before, sending: true, failed: null } : {
        id: Number.MAX_SAFE_INTEGER, conversationId: id, senderId: s.me, kind: 'TEXT', body, payload: mentions.length ? { mentions } : null, ref, at: new Date().toISOString(), invite: null, sending: true, attachments: shown(files), reactions: [],
        replyTo: reply ? { id: reply.id, senderId: reply.senderId, senderName: reply.senderName ?? '', kind: reply.kind, text: reply.deleted ? '' : reply.body.slice(0, 160), deleted: !!reply.deleted, attachment: reply.attachments?.length ? reply.attachments[0].kind : null } : null,
      };
      set(st => ({ threads: { ...st.threads, [id]: { ...(st.threads[id] ?? { more: false, loading: false, loaded: true, error: false, messages: [] }), messages: upsert(st.threads[id]?.messages ?? [], draft) } } }));
      const progress = (key: string, fraction: number) => inThread(id, m => m.ref === ref ? { ...m, attachments: m.attachments?.map(a => a.id === key ? { ...a, progress: fraction } : a) } : m);
      try {
        // The files go first, one at a time; one that already went is not sent again.
        for (const f of files) {
          if (f.uploaded) continue;
          f.uploaded = await messengerApi.upload(id, f.blob, f.name, f.thumb, fraction => progress(f.key, fraction * 0.98));
          progress(f.key, 1);
        }
        const sent = await messengerApi.send(id, ref, draft.body, draft.replyTo?.id ?? null, files.map(f => f.uploaded!.id), mentions);
        files.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
        outbox.delete(ref); named.delete(ref);
        get().handle({ type: 'MESSAGE', conversationId: id, message: sent, userId: s.me });
        if (!get().conversations.some(c => c.id === id && c.last)) soonLists(0);
      } catch (e) {
        const code = errorCode(e, (e as { response?: { status?: number } })?.response?.status === 413 ? 'ATTACHMENT_TOO_LARGE' : 'UNAVAILABLE');
        // Files the server no longer holds (an hour passed) are uploaded again by the retry.
        if (code === 'ATTACHMENT_GONE') files.forEach(f => { f.uploaded = undefined; });
        inThread(id, m => m.ref === ref ? { ...m, sending: false, failed: code } : m);
      }
    },
    async share(id, kind, targetId) {
      const sent = await messengerApi.share(id, uuid(), kind, targetId);
      get().handle({ type: 'MESSAGE', conversationId: id, message: sent, userId: get().me });
    },
    async invite(id, mode) {
      try {
        const sent = await messengerApi.invite(id, uuid(), mode);
        get().handle({ type: 'MESSAGE', conversationId: id, message: sent, userId: get().me });
        return null;
      } catch (e) { return errorCode(e); }
    },
    async answer(invite, answer) {
      const next = await messengerApi[answer](invite.id);
      set(s => ({
        threads: Object.fromEntries(Object.entries(s.threads).map(([k, t]) => [k, { ...t, messages: setInvite(t.messages, next) }])),
        conversations: s.conversations.map(c => c.last?.invite?.id === next.id ? { ...c, last: { ...c.last, invite: next } } : c),
        cards: s.cards.filter(c => !('invite' in c && c.invite.id === next.id)),
      }));
      return next;
    },
    async answerRequest(id, answer) {
      await (answer === 'accept' ? messengerApi.acceptRequest(id) : messengerApi.declineRequest(id));
      set(s => {
        const c = s.requests.find(x => x.id === id);
        return {
          requests: s.requests.filter(x => x.id !== id), messageRequests: Math.max(0, s.messageRequests - 1), viewing: answer === 'decline' && s.viewing === id ? null : s.viewing,
          conversations: answer === 'accept' && c ? [{ ...c, connected: true, request: null, refused: null }, ...s.conversations.filter(x => x.id !== id)] : s.conversations,
        };
      });
      soonLists(0);
    },
    async startWith(userId) {
      const c = await messengerApi.open(userId);
      get().adopt(c);
      return c.id;
    },
    async react(message, emoji) {
      const id = message.conversationId, was = message.reactions;
      inThread(id, m => m.id === message.id ? { ...m, reactions: withMine(m.reactions, emoji) } : m);
      try { await messengerApi.react(message.id, emoji); }
      catch (e) { inThread(id, m => m.id === message.id ? { ...m, reactions: was } : m); throw e; }
    },
    async unsend(message) {
      await messengerApi.unsend(message.id);
      get().handle({ type: 'UNSENT', conversationId: message.conversationId, userId: get().me, upTo: message.id });
    },
    async configure(id, patch) {
      await messengerApi.settings(id, patch);
      if (patch.hidden) set(s => ({ conversations: s.conversations.filter(c => c.id !== id), aside: { ARCHIVED: s.aside.ARCHIVED?.filter(c => c.id !== id) ?? null, RESTRICTED: s.aside.RESTRICTED?.filter(c => c.id !== id) ?? null } }));
      else set(s => everywhere(s, id, c => ({ ...c, ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(patch.markedUnread !== undefined ? { markedUnread: patch.markedUnread } : {}), ...(patch.theme ? { theme: patch.theme } : {}),
        ...(patch.mute ? { muted: patch.mute !== 'OFF', mutedUntil: patch.mute === 'OFF' ? null : c.mutedUntil } : {}) })));
      await get().load();
    },
    adopt(c) { set(s => s.conversations.some(x => x.id === c.id) || s.requests.some(x => x.id === c.id) ? s : { conversations: [c, ...s.conversations] }); },
    askView(view) { set({ wantView: view }); },
    dismiss(key) { set(s => ({ cards: s.cards.filter(c => c.key !== key) })); },
    handle(event) {
      const s = get();
      switch (event.type) {
        case 'CONNECTED': {
          // The socket of a page that has just asked has nothing new to learn. A real reconnect does; a release reconnects everyone at once, so everyone asks a little apart.
          if (Date.now() - askedAt > 15000) {
            askedAt = Date.now();
            soonSummary(500 + Math.random() * 4000);
            soonLists(800 + Math.random() * 2000);
          }
          if (s.viewing) void s.open(s.viewing);
          return;
        }
        case 'PEOPLE': { soonSummary(); soonLists(); return; }
        case 'CONVERSATION': {
          set(st => ({ rev: { ...st.rev, [event.conversationId]: (st.rev[event.conversationId] ?? 0) + 1 } }));
          soonLists();
          return;
        }
        case 'REMOVED': {
          const id = event.conversationId;
          set(st => ({ conversations: st.conversations.filter(c => c.id !== id), aside: { ARCHIVED: st.aside.ARCHIVED?.filter(c => c.id !== id) ?? null, RESTRICTED: st.aside.RESTRICTED }, viewing: st.viewing === id ? null : st.viewing,
            cards: st.cards.filter(c => !('conversationId' in c && c.conversationId === id)), rev: { ...st.rev, [id]: (st.rev[id] ?? 0) + 1 } }));
          soonSummary();
          return;
        }
        case 'FRIEND_REQUEST':
        case 'FRIEND_ACCEPTED': {
          const key = `f:${event.userId}`, kind = event.type === 'FRIEND_REQUEST' ? 'friend-request' as const : 'friend-accepted' as const;
          set(st => ({ cards: [...st.cards.filter(c => c.key !== key), { key, kind, userId: event.userId, name: event.name, at: Date.now() }], friendRequests: event.type === 'FRIEND_REQUEST' ? st.friendRequests + 1 : st.friendRequests }));
          soonSummary(); soonLists();
          return;
        }
        case 'MESSAGE_REQUEST':
        case 'REQUEST_ACCEPTED': {
          const key = `r:${event.conversationId}`, kind = event.type === 'MESSAGE_REQUEST' ? 'message-request' as const : 'request-accepted' as const;
          set(st => ({ cards: [...st.cards.filter(c => c.key !== key), { key, kind, conversationId: event.conversationId, name: event.name, at: Date.now() }] }));
          soonSummary(); soonLists();
          return;
        }
        case 'PRESENCE': {
          const mark = <T extends MessengerPerson | null>(p: T): T => p && p.id === event.userId ? { ...p, online: event.online, lastActiveAt: event.online ? null : event.lastActiveAt ?? null } : p;
          set(st => ({
            conversations: st.conversations.map(c => ({ ...c, other: mark(c.other) })),
            people: { ...st.people, friends: st.people.friends.map(mark) },
          }));
          return;
        }
        case 'TYPING': {
          if (event.userId === s.me) return;
          set(st => ({ typing: { ...st.typing, [event.conversationId]: { until: Date.now() + 3500, name: event.name ?? null } } }));
          return;
        }
        case 'READ': {
          set(st => everywhere(st, event.conversationId, c => {
            // The same person on another device: it is read here too.
            if (event.userId === st.me) return { ...c, myRead: Math.max(c.myRead, event.upTo), markedUnread: false, unread: (c.last?.id ?? 0) <= event.upTo ? 0 : c.unread };
            return { ...c, theirRead: Math.max(c.theirRead, event.upTo), theirDelivered: Math.max(c.theirDelivered, event.upTo) };
          }));
          if (event.userId === s.me && !readTimers.has(event.conversationId)) soonSummary();
          return;
        }
        case 'DELIVERED': {
          set(st => ({ conversations: st.conversations.map(c => c.id === event.conversationId && event.userId !== st.me ? { ...c, theirDelivered: Math.max(c.theirDelivered, event.upTo) } : c) }));
          return;
        }
        case 'REACTION': {
          // My own (from this page or another of mine) is known exactly; someone else's needs the message's new summary.
          if (event.userId === s.me) inThread(event.conversationId, m => m.id === event.upTo ? { ...m, reactions: withMine(m.reactions, event.emoji ?? null) } : m);
          else if (s.threads[event.conversationId]?.messages.some(m => m.id === event.upTo)) refreshMessage(event.conversationId, event.upTo);
          return;
        }
        case 'UNSENT': {
          const gone = (m: ChatMessage): ChatMessage => m.id === event.upTo ? unsent(m) : m.replyTo?.id === event.upTo ? { ...m, replyTo: { ...m.replyTo, text: '', deleted: true, attachment: null } } : m;
          inThread(event.conversationId, gone);
          set(st => everywhere(st, event.conversationId, c => c.last?.id === event.upTo ? { ...c, last: unsent(c.last) } : c));
          return;
        }
        case 'MESSAGE': {
          const m = event.message, mine = m.senderId === s.me, id = event.conversationId, quiet = !!event.quiet;
          const known = s.conversations.find(c => c.id === id);
          const aside = !known && (s.aside.ARCHIVED?.some(c => c.id === id) || s.aside.RESTRICTED?.some(c => c.id === id));
          if (!known) soonLists();
          const showing = s.viewing === id && typeof document !== 'undefined' && document.visibilityState === 'visible';
          const already = s.threads[id]?.messages.some(x => x.id === m.id && !x.sending);
          // A line the conversation says about itself, or a message from someone restricted or blocked, arrives without a number or a card.
          const counts = !mine && !showing && !already && !quiet;
          set(st => {
            const thread = st.threads[id];
            // To the top of the list — below the pinned ones, which keep their place.
            const bumped = known ? { ...known, last: m, unread: counts ? known.unread + 1 : known.unread } : null;
            const moved = !bumped ? st.conversations : bumped.pinned ? st.conversations.map(c => c.id === id ? bumped : c)
              : [...st.conversations.filter(c => c.pinned), bumped, ...st.conversations.filter(c => !c.pinned && c.id !== id)];
            const typing = { ...st.typing }; if (!mine) delete typing[id];
            const others = aside ? everywhere(st, id, c => ({ ...c, last: m })) : null;
            return { ...(others ? { aside: others.aside } : {}), threads: thread ? { ...st.threads, [id]: { ...thread, messages: upsert(thread.messages, m) } } : st.threads, conversations: moved, unread: counts && known ? st.unread + 1 : st.unread, typing };
          });
          if (showing && !mine) get().markRead(id);
          // Named with "@": a card even when the group is muted (the server kept the mention only for a real member, where the name stands).
          const calledMe = !!m.payload?.mentions?.some(x => x.id === s.me);
          if (counts && (!known?.muted || calledMe) && m.kind !== 'ARENA_INVITE' && m.kind !== 'SYSTEM') {
            const group = known?.kind === 'GROUP' || (!known && !!m.senderName && event.name !== m.senderName);
            const name = known ? titleOf(known) : event.name ?? '';
            const vi = typeof document === 'undefined' || document.documentElement.lang !== 'en';
            const words = previewOf(m, vi);
            const lead = calledMe && m.senderName ? `${m.senderName} ${vi ? 'nhắc đến bạn' : 'mentioned you'}: ` : group && m.senderName ? `${m.senderName}: ` : '';
            const card: Card = { key: `m:${id}`, kind: 'message', conversationId: id, name, text: `${lead}${words}`, at: Date.now() };
            set(st => ({ cards: [...st.cards.filter(c => c.key !== card.key), card] }));
          }
          return;
        }
        case 'INVITE': {
          const invite = event.invite, mineToAnswer = invite.inviteeId === s.me;
          set(st => {
            const threads = Object.fromEntries(Object.entries(st.threads).map(([k, t]) => [k, { ...t, messages: setInvite(t.messages, invite) }]));
            const conversations = st.conversations.map(c => c.last?.invite?.id === invite.id ? { ...c, last: { ...c.last, invite } } : c);
            let cards = st.cards.filter(c => !('invite' in c && c.invite.id === invite.id));
            const at = Date.now();
            if (invite.status === 'PENDING' && mineToAnswer) cards = [...cards, { key: `i:${invite.id}`, kind: 'invite', conversationId: event.conversationId, name: event.name, invite, at }];
            // The person who invited hears the answer. The person who just said yes is already on their way.
            if (invite.status === 'ACCEPTED' && !mineToAnswer) cards = [...cards, { key: `i:${invite.id}`, kind: 'accepted', conversationId: event.conversationId, name: event.name, invite, at }];
            if (invite.status === 'DECLINED' && !mineToAnswer) cards = [...cards, { key: `i:${invite.id}`, kind: 'declined', conversationId: event.conversationId, name: event.name, invite, at }];
            return { threads, conversations, cards };
          });
          return;
        }
      }
    },
  };
});

/** Clears all account-scoped Messenger state, pending timers, and local object URLs on logout or account switch. */
export function resetMessengerStore(): void {
  clearMessengerPendingBuffers();
  useMessenger.setState({ ...EMPTY_MESSENGER_STATE });
}

registerUserScopedCleanup(resetMessengerStore);

// From the first moment the page can hear anything: what arrives while the rest of the page is still loading must not be lost.
onMessenger(event => useMessenger.getState().handle(event));

/** The list from the server wins; a conversation just opened that has no message yet stays on this screen. */
function mergeLocalConversations(local: Conversation[], server: Conversation[]) {
  const empties = local.filter(c => !c.last && !server.some(s => s.id === c.id));
  return [...empties, ...server];
}
