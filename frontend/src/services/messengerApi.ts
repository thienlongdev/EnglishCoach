import { apiClient } from './api-client';
import type { ArenaInvite, Attachment, ChatMessage, Conversation, ConversationPage, ConversationSettings, GroupDetail, GroupRole, InviteMode, ListScope, Mention, MessagePage, MessengerMe, MessengerPeople, MessengerProfile, MessengerSummary, PersonPage, ReactionPeople } from '@/types/messenger';

const B = '/messenger';
/** Where the bytes of a file are read from: the person's own session, people of the conversation only. Never a public address. */
export const attachmentUrl = (id: string, thumb = false) => `/api/v1${B}/attachments/${id}${thumb ? '/thumb' : ''}`;
export const messengerApi = {
  me: () => apiClient.get<MessengerMe>(`${B}/me`).then(r => r.data),
  updateMe: (patch: Partial<MessengerMe>) => apiClient.put<MessengerMe>(`${B}/me`, patch).then(r => r.data),
  summary: () => apiClient.get<MessengerSummary>(`${B}/summary`).then(r => r.data),
  people: (offset = 0) => apiClient.get<MessengerPeople>(`${B}/people`, { params: { offset: offset || undefined } }).then(r => r.data),
  search: (q: string, after?: string | null) => apiClient.get<PersonPage>(`${B}/people/search`, { params: { q, after: after || undefined } }).then(r => r.data),
  profile: (id: number) => apiClient.get<MessengerProfile>(`${B}/people/${id}`).then(r => r.data),
  addFriend: (id: number) => apiClient.post(`${B}/friends/${id}`).then(() => undefined),
  removeFriend: (id: number) => apiClient.delete(`${B}/friends/${id}`).then(() => undefined),
  declineFriend: (id: number) => apiClient.post(`${B}/friends/${id}/decline`).then(() => undefined),
  block: (id: number) => apiClient.post(`${B}/blocks/${id}`).then(() => undefined),
  unblock: (id: number) => apiClient.delete(`${B}/blocks/${id}`).then(() => undefined),
  restrict: (id: number) => apiClient.post(`${B}/restrictions/${id}`).then(() => undefined),
  unrestrict: (id: number) => apiClient.delete(`${B}/restrictions/${id}`).then(() => undefined),
  conversations: (before?: string | null, scope?: ListScope) => apiClient.get<ConversationPage>(`${B}/conversations`, { params: { before: before || undefined, scope: scope && scope !== 'MAIN' ? scope : undefined } }).then(r => r.data),
  requests: () => apiClient.get<Conversation[]>(`${B}/requests`).then(r => r.data),
  acceptRequest: (id: string) => apiClient.post(`${B}/requests/${id}/accept`).then(() => undefined),
  declineRequest: (id: string) => apiClient.post(`${B}/requests/${id}/decline`).then(() => undefined),
  open: (userId: number) => apiClient.post<Conversation>(`${B}/conversations`, { userId }).then(r => r.data),
  messages: (id: string, before?: number, q?: string, downTo?: number) => apiClient.get<MessagePage>(`${B}/conversations/${id}/messages`, { params: { before, q: q || undefined, downTo } }).then(r => r.data),
  send: (id: string, ref: string, body: string, replyTo?: number | null, attachments?: string[], mentions?: Mention[]) => apiClient.post<ChatMessage>(`${B}/conversations/${id}/messages`, { ref, body, replyTo: replyTo ?? undefined, attachments: attachments?.length ? attachments : undefined, mentions: mentions?.length ? mentions : undefined }).then(r => r.data),
  share: (id: string, ref: string, kind: 'READING' | 'DECK', targetId: number) => apiClient.post<ChatMessage>(`${B}/conversations/${id}/share`, { ref, kind, targetId }).then(r => r.data),
  read: (id: string, messageId: number) => apiClient.put(`${B}/conversations/${id}/read`, { messageId }).then(() => undefined),
  settings: (id: string, patch: ConversationSettings) => apiClient.put(`${B}/conversations/${id}/settings`, patch).then(() => undefined),
  roomInvites: (id:string) => apiClient.get<ArenaInvite[]>(`${B}/arena-invites/room/${id}`).then(r=>r.data),
  invite: (id: string, ref: string, mode: InviteMode, roomId?:string) => apiClient.post<ChatMessage>(`${B}/conversations/${id}/arena-invites`, { ref, mode, roomId }).then(r => r.data),
  accept: (id: string) => apiClient.post<ArenaInvite>(`${B}/arena-invites/${id}/accept`).then(r => r.data),
  decline: (id: string) => apiClient.post<ArenaInvite>(`${B}/arena-invites/${id}/decline`).then(r => r.data),
  cancel: (id: string) => apiClient.post<ArenaInvite>(`${B}/arena-invites/${id}/cancel`).then(r => r.data),
  react: (messageId: number, emoji: string | null) => (emoji ? apiClient.put(`${B}/messages/${messageId}/reaction`, { emoji }) : apiClient.delete(`${B}/messages/${messageId}/reaction`)).then(() => undefined),
  reactors: (messageId: number) => apiClient.get<ReactionPeople[]>(`${B}/messages/${messageId}/reactions`).then(r => r.data),
  unsend: (messageId: number) => apiClient.delete(`${B}/messages/${messageId}`).then(() => undefined),
  /** One file for the composer of this conversation. The picture's small preview is made on this device and sent beside it. */
  upload: (id: string, file: Blob, name: string, thumb: Blob | null, onProgress?: (fraction: number) => void) => {
    const form = new FormData();
    form.append('file', file, name);
    if (thumb) form.append('thumb', thumb, 'thumb');
    form.append('name', name);
    return apiClient.post<Attachment>(`${B}/conversations/${id}/attachments`, form, { timeout: 120000, onUploadProgress: e => { if (onProgress && e.total) onProgress(Math.min(1, e.loaded / e.total)); } }).then(r => r.data);
  },
  discard: (attachmentId: string) => apiClient.delete(`${B}/attachments/${attachmentId}`).then(() => undefined),
  shared: (id: string, kind: 'IMAGE' | 'FILE') => apiClient.get<Attachment[]>(`${B}/conversations/${id}/shared`, { params: { kind } }).then(r => r.data),
  createGroup: (title: string, members: number[]) => apiClient.post<Conversation>(`${B}/groups`, { title, members }).then(r => r.data),
  group: (id: string) => apiClient.get<GroupDetail>(`${B}/groups/${id}`).then(r => r.data),
  renameGroup: (id: string, title: string) => apiClient.put<Conversation>(`${B}/groups/${id}`, { title }).then(r => r.data),
  groupAvatar: (id: string, picture: Blob) => { const form = new FormData(); form.append('file', picture, 'avatar'); return apiClient.put<Conversation>(`${B}/groups/${id}/avatar`, form).then(r => r.data); },
  addMembers: (id: string, members: number[]) => apiClient.post<GroupDetail>(`${B}/groups/${id}/members`, { members }).then(r => r.data),
  removeMember: (id: string, user: number) => apiClient.delete<GroupDetail>(`${B}/groups/${id}/members/${user}`).then(r => r.data),
  setRole: (id: string, user: number, role: GroupRole) => apiClient.put<GroupDetail>(`${B}/groups/${id}/members/${user}/role`, { role }).then(r => r.data),
  leaveGroup: (id: string) => apiClient.post(`${B}/groups/${id}/leave`).then(() => undefined),
};
