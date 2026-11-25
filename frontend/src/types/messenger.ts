/** Echo Messenger over HTTP and over the private queue. */
export type Relation = 'FRIEND' | 'INCOMING' | 'OUTGOING' | 'BLOCKED' | 'NONE' | 'SELF';
/** `online` / `lastActiveAt` are only ever told to someone allowed to see them; last active is never older than seven days. */
export interface MessengerPerson { id: number; name: string; avatarUrl: string | null; online: boolean; username?: string | null; relation?: Relation | null; lastActiveAt?: string | null }
export interface MessengerPeople { friends: MessengerPerson[]; incoming: MessengerPerson[]; outgoing: MessengerPerson[]; blocked: MessengerPerson[]; moreFriends?: boolean; restricted?: MessengerPerson[]; now?: string }
export interface PersonPage { items: MessengerPerson[]; next: string | null }
export interface MessengerProfile { person: MessengerPerson; self: boolean; refused: RefusedReason | null; connected: boolean; conversationId: string | null; followers: number; following: number; streakDays: number; cefrLevel: string | null; premium: boolean; restricted?: boolean }
export interface MessengerMe { username: string; messagePolicy: 'EVERYONE' | 'FRIENDS'; discoverable: boolean; showActivity: boolean }
export interface MessengerSummary { unread: number; messageRequests: number; friendRequests: number }
export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'CLOSED';
export type InviteMode = 'FREE' | 'GUIDED' | 'DUEL' | 'TEAM';
export interface ArenaInvite { id: string; status: InviteStatus; mode: InviteMode; inviterId: number; inviteeId: number; expiresAt: string; code: string | null }
export type MessageKind = 'TEXT' | 'ARENA_INVITE' | 'SHARE_READING' | 'SHARE_DECK' | 'SYSTEM';
export interface ReplyPreview { id: number; senderId: number; senderName: string; kind: MessageKind; text: string; deleted: boolean; attachment: 'IMAGE' | 'FILE' | null }
export interface Reaction { emoji: string; count: number; mine: boolean }
export interface Attachment {
  id: string; kind: 'IMAGE' | 'FILE'; name: string; mime: string; size: number; width: number | null; height: number | null; thumb: boolean;
  /** Only on this device, while the file is on its way: a preview from the file itself, and how far the upload is (0–1). */
  localUrl?: string; progress?: number;
}
export interface MessagePayload {
  id?: number; title?: string; mode?: string;
  att?: { images: number; files: number };
  /** A line the conversation says about itself. */
  event?: 'created' | 'added' | 'removed' | 'left' | 'renamed' | 'theme' | 'avatar' | 'role'; actor?: string; names?: string; theme?: string; role?: string;
  /** People named with "@" in a group message, kept by the server only where the name really stands: [person, offset of the "@", length]. */
  mentions?: Mention[];
}
export interface Mention { id: number; at: number; len: number }
export interface ChatMessage {
  id: number; conversationId: string; senderId: number; kind: MessageKind; body: string; payload: MessagePayload | null;
  ref: string; at: string; invite: ArenaInvite | null;
  senderName?: string | null; senderAvatarUrl?: string | null; replyTo?: ReplyPreview | null; reactions?: Reaction[]; attachments?: Attachment[]; deleted?: boolean;
  /** Still on its way, or refused: only on this device. */
  sending?: boolean; failed?: string | null;
}
export type RefusedReason = 'NOT_FRIENDS' | 'BLOCKED_BY_ME' | 'UNAVAILABLE' | 'RESTRICTED' | 'FRIENDS_ONLY' | 'REQUEST_TO_ANSWER';
export type ThemeId = 'pearl' | 'ocean' | 'abyss' | 'aurora' | 'lavender' | 'sunset' | 'mint' | 'rose' | 'midnight' | 'sand';
export type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export interface Conversation {
  id: string;
  /** The person, in a conversation of two; null in a group. */
  other: MessengerPerson | null;
  last: ChatMessage | null; unread: number; myRead: number; theirRead: number; theirDelivered: number; muted: boolean; refused: RefusedReason | null;
  /** Friends, or a request that was accepted. */
  connected: boolean;
  /** MINE: my first messages are waiting for them. THEIRS: theirs are waiting for me. */
  request: 'MINE' | 'THEIRS' | null;
  kind: 'DIRECT' | 'GROUP'; title: string | null; avatarUrl: string | null; memberCount: number; role: GroupRole | null; theme: ThemeId;
  pinned: boolean; archived: boolean; mutedUntil: string | null;
  /** I restricted this person: the conversation waits aside. */
  restricted: boolean; markedUnread: boolean;
}
export interface ConversationPage { items: Conversation[]; more: boolean; now?: string }
export interface MessagePage { messages: ChatMessage[]; more: boolean; myRead: number; theirRead: number; theirDelivered: number }
export interface GroupMember { person: MessengerPerson; role: GroupRole; joinedAt: string }
export interface GroupDetail { conversation: Conversation; members: GroupMember[]; limit: number }
export interface ReactionPeople { emoji: string; people: MessengerPerson[] }
export type MuteFor = 'OFF' | 'H1' | 'H8' | 'D1' | 'FOREVER';
export interface ConversationSettings { mute?: MuteFor; hidden?: boolean; pinned?: boolean; archived?: boolean; markedUnread?: boolean; theme?: ThemeId; muted?: boolean }
export type ListScope = 'MAIN' | 'ARCHIVED' | 'RESTRICTED';
export type MessengerEvent =
  | { type: 'CONNECTED' }
  | { type: 'MESSAGE'; conversationId: string; message: ChatMessage; userId: number; invite?: ArenaInvite | null; name?: string | null; quiet?: boolean | null }
  | { type: 'READ'; conversationId: string; userId: number; upTo: number }
  | { type: 'DELIVERED'; conversationId: string; userId: number; upTo: number }
  | { type: 'TYPING'; conversationId: string; userId: number; name?: string | null }
  | { type: 'PRESENCE'; userId: number; online: boolean; lastActiveAt?: string | null }
  | { type: 'INVITE'; conversationId: string; invite: ArenaInvite; name: string }
  | { type: 'MESSAGE_REQUEST'; conversationId: string; userId: number; name: string }
  | { type: 'REQUEST_ACCEPTED'; conversationId: string; userId: number; name: string }
  | { type: 'FRIEND_REQUEST'; userId: number; name: string }
  | { type: 'FRIEND_ACCEPTED'; userId: number; name: string }
  | { type: 'REACTION'; conversationId: string; userId: number; upTo: number; emoji?: string | null }
  | { type: 'UNSENT'; conversationId: string; userId: number; upTo: number }
  | { type: 'CONVERSATION'; conversationId: string }
  | { type: 'REMOVED'; conversationId: string }
  | { type: 'PEOPLE' };
