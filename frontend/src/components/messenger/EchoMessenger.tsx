'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Archive, ArchiveRestore, ArrowLeft, Bell, BellOff, Check, EyeOff, Inbox, Loader2, MailOpen, MessageCircle, MoreHorizontal, Pin, PinOff, RotateCw, Search, Send, Settings, Trash2, UserPlus, Users, UsersRound, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { messengerApi } from '@/services/messengerApi';
import { requestArenaJoin } from '@/lib/messenger/bus';
import { errorCode, previewOf, titleOf, useMessenger, type MessengerView } from '@/lib/messenger/store';
import type { Conversation, MessengerMe, MessengerPerson, MuteFor } from '@/types/messenger';
import { Avatar } from './MessageParts';
import Thread, { clock, word } from './Thread';
import s from './messenger.module.css';

const PersonCard = dynamic(() => import('./PersonCard'), { ssr: false });
const ConversationDetails = dynamic(() => import('./Details'), { ssr: false });
const GroupDialog = dynamic(() => import('./Details').then(m => m.GroupDialog), { ssr: false });

/**
 * Echo Messenger: the same application on the page, on the laptop and on the desktop PC in the room. Conversations of two and groups, replies, reactions, pictures and
 * files, a shared theme for each conversation, and a person's own choices about each one. It lays itself out by the room it is given (its own width, not the window's):
 * a list, the conversation, and its details side by side when there is room; one of them at a time when there is not. Nothing here asks a model anything.
 */
const shortWhen = (at: string, vi: boolean) => {
  const d = new Date(at), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(at, vi ? 'vi-VN' : 'en-GB');
  if (now.getTime() - d.getTime() < 6 * 864e5) return new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { weekday: 'short' }).format(d);
  return new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit' }).format(d);
};
const preview = (c: Conversation, me: number, vi: boolean) => {
  const m = c.last;
  if (!m) return c.kind === 'GROUP' ? (vi ? 'Nhóm mới' : 'New group') : (vi ? 'Bắt đầu trò chuyện' : 'Say hello');
  if (m.kind === 'SYSTEM') return m.body;
  const who = m.senderId === me ? (vi ? 'Bạn: ' : 'You: ') : c.kind === 'GROUP' && m.senderName ? `${m.senderName}: ` : '';
  return who + previewOf(m, vi);
};

type Filter = 'all' | 'unread' | 'groups' | 'archived' | 'restricted';

/** One conversation in the list. The row opens it; the small menu beside it holds a person's own choices for it. */
function ConversationRow({ c, me, vi, active, onOpen, onError }: { c: Conversation; me: number; vi: boolean; active: boolean; onOpen: (id: string) => void; onError: (text: string | null) => void }) {
  const configure = useMessenger(st => st.configure), loadAside = useMessenger(st => st.loadAside);
  const [menu, setMenu] = useState(false);
  const title = titleOf(c), unread = c.unread > 0 || c.markedUnread;
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    const t = window.setTimeout(() => document.addEventListener('click', away), 0);
    document.addEventListener('keydown', key);
    return () => { clearTimeout(t); document.removeEventListener('click', away); document.removeEventListener('keydown', key); };
  }, [menu]);
  const act = (patch: Parameters<typeof configure>[1]) => { setMenu(false); onError(null); void configure(c.id, patch).then(() => { if (patch.archived !== undefined) void loadAside('ARCHIVED'); }).catch(e => onError(word(errorCode(e), vi))); };
  const mute = (m: MuteFor) => act({ mute: m });
  return <div className={s.itemWrap} data-active={active || undefined} data-unread={unread || undefined} data-menu={menu || undefined}>
    <button type="button" className={s.item} data-conversation="" onClick={() => onOpen(c.id)} data-testid={c.kind === 'GROUP' ? `msgr-group-${c.id}` : `msgr-conv-${c.other?.id}`} aria-current={active ? 'true' : undefined}>
      <Avatar name={title} src={c.kind === 'GROUP' ? c.avatarUrl : c.other?.avatarUrl} online={c.kind === 'DIRECT' && !!c.other?.online} size={46} group={c.kind === 'GROUP'} />
      <span className={s.itemText}><b>{title}</b><span>{preview(c, me, vi)}</span></span>
      <span className={s.itemMeta}>
        {c.last && <time>{shortWhen(c.last.at, vi)}</time>}
        <span>{c.pinned && <Pin size={12} aria-label={vi ? 'Đã ghim' : 'Pinned'} />}{c.muted && <BellOff size={12} aria-label={vi ? 'Đã tắt thông báo' : 'Muted'} />}
          {c.unread > 0 ? <em>{c.unread > 99 ? '99+' : c.unread}</em> : c.markedUnread ? <em data-dot="" aria-label={vi ? 'Đánh dấu chưa đọc' : 'Marked unread'} /> : null}</span>
      </span>
    </button>
    <button type="button" className={s.itemMore} aria-label={vi ? `Tuỳ chọn cho ${title}` : `Options for ${title}`} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(v => !v)} data-testid="msgr-row-menu"><MoreHorizontal size={16} /></button>
    {menu && <div className={s.menu} role="menu" data-testid="msgr-row-menu-list">
      <button type="button" role="menuitem" onClick={() => act({ pinned: !c.pinned })} data-testid="msgr-row-pin">{c.pinned ? <PinOff size={15} /> : <Pin size={15} />}{c.pinned ? (vi ? 'Bỏ ghim' : 'Unpin') : (vi ? 'Ghim lên đầu' : 'Pin to top')}</button>
      <button type="button" role="menuitem" onClick={() => act({ markedUnread: !unread })} data-testid="msgr-row-unread"><MailOpen size={15} />{unread ? (vi ? 'Đánh dấu đã đọc' : 'Mark as read') : (vi ? 'Đánh dấu chưa đọc' : 'Mark as unread')}</button>
      {c.muted ? <button type="button" role="menuitem" onClick={() => mute('OFF')} data-testid="msgr-row-unmute"><Bell size={15} />{vi ? 'Bật thông báo' : 'Unmute'}</button> : <>
        <button type="button" role="menuitem" onClick={() => mute('H1')} data-testid="msgr-row-mute-h1"><BellOff size={15} />{vi ? 'Tắt thông báo 1 giờ' : 'Mute for 1 hour'}</button>
        <button type="button" role="menuitem" onClick={() => mute('D1')}><BellOff size={15} />{vi ? 'Tắt thông báo 24 giờ' : 'Mute for 24 hours'}</button>
        <button type="button" role="menuitem" onClick={() => mute('FOREVER')} data-testid="msgr-row-mute"><BellOff size={15} />{vi ? 'Tắt đến khi bật lại' : 'Mute until turned on'}</button>
      </>}
      <button type="button" role="menuitem" onClick={() => act({ archived: !c.archived })} data-testid="msgr-row-archive">{c.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{c.archived ? (vi ? 'Bỏ lưu trữ' : 'Unarchive') : (vi ? 'Lưu trữ' : 'Archive')}</button>
      <button type="button" role="menuitem" data-danger="" onClick={() => act({ hidden: true })} data-testid="msgr-row-hide"><Trash2 size={15} />{vi ? 'Xoá khỏi danh sách của tôi' : 'Remove from my list'}</button>
    </div>}
  </div>;
}

function ChatsPanel({ vi, active, onOpen, onFind, onGroup }: { vi: boolean; active: string | null; onOpen: (id: string) => void; onFind: () => void; onGroup: () => void }) {
  const me = useMessenger(st => st.me), conversations = useMessenger(st => st.conversations), aside = useMessenger(st => st.aside), ready = useMessenger(st => st.ready), listFailed = useMessenger(st => st.listFailed), load = useMessenger(st => st.load), loadAside = useMessenger(st => st.loadAside), moreChats = useMessenger(st => st.moreChats), moreConversations = useMessenger(st => st.moreConversations);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<Filter>('all'), [error, setError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  // The filter chips scroll sideways only when they do not fit; a plain mouse wheel scrolls them too (trackpads and touch already do).
  const chipRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chipRow.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; e.preventDefault(); el.scrollLeft += e.deltaY; };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => { if (filter === 'archived') void loadAside('ARCHIVED'); if (filter === 'restricted') void loadAside('RESTRICTED'); }, [filter, loadAside]);
  const source = filter === 'archived' ? aside.ARCHIVED : filter === 'restricted' ? aside.RESTRICTED : conversations;
  const list = useMemo(() => (source ?? []).filter(c => (filter !== 'unread' || c.unread > 0 || c.markedUnread) && (filter !== 'groups' || c.kind === 'GROUP')
    && (!q || titleOf(c).toLowerCase().includes(q) || c.last?.body.toLowerCase().includes(q))), [source, filter, q]);
  const loading = filter === 'archived' || filter === 'restricted' ? source === null : !ready && !listFailed;
  const keyList = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-conversation]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  };
  const chips: { id: Filter; vi: string; en: string }[] = [{ id: 'all', vi: 'Tất cả', en: 'All' }, { id: 'unread', vi: 'Chưa đọc', en: 'Unread' }, { id: 'groups', vi: 'Nhóm', en: 'Groups' }, { id: 'archived', vi: 'Lưu trữ', en: 'Archived' }, { id: 'restricted', vi: 'Hạn chế', en: 'Restricted' }];
  const empty = filter === 'archived' ? (vi ? 'Không có cuộc trò chuyện nào được lưu trữ.' : 'No archived conversations.') : filter === 'restricted' ? (vi ? 'Bạn chưa hạn chế ai.' : 'You have not restricted anyone.')
    : filter === 'unread' ? (vi ? 'Bạn đã đọc hết tin nhắn.' : 'You are all caught up.') : filter === 'groups' ? (vi ? 'Bạn chưa ở trong nhóm nào.' : 'You are not in any group yet.') : (vi ? 'Chưa có trò chuyện nào.' : 'No conversations yet.');
  return <>
    <label className={s.search}><Search size={15} aria-hidden="true" /><input data-testid="msgr-filter-chats" value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm trong trò chuyện…' : 'Search conversations…'} aria-label={vi ? 'Tìm trong trò chuyện' : 'Search conversations'} /></label>
    <div className={s.chips} role="tablist" aria-label={vi ? 'Lọc trò chuyện' : 'Filter conversations'} ref={chipRow} data-testid="msgr-chips">
      {chips.map(c => <button type="button" role="tab" key={c.id} aria-selected={filter === c.id} onClick={e => { setFilter(c.id); e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }} data-testid={`msgr-chip-${c.id}`}>{vi ? c.vi : c.en}</button>)}
    </div>
    {error && <p className={s.inviteError} role="alert" style={{ margin: '0 14px 6px' }} data-testid="msgr-list-error">{error}</p>}
    <div className={s.list} onKeyDown={keyList} data-testid="msgr-list">
      {listFailed && filter !== 'archived' && filter !== 'restricted' && <div className={s.state} role="alert"><p>{vi ? 'Chưa tải được danh sách trò chuyện.' : 'Could not load your conversations.'}</p><button type="button" className={s.quiet} onClick={() => void load()}><RotateCw size={14} />{vi ? 'Thử lại' : 'Try again'}</button></div>}
      {loading && <div className={s.state}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div>}
      {!loading && !listFailed && !list.length && <div className={s.state} data-testid="msgr-no-chats"><p>{q ? (vi ? 'Không có trò chuyện nào khớp.' : 'No conversation matches.') : empty}</p>
        {!q && filter === 'all' && <button type="button" className={s.quiet} onClick={onFind}><Search size={14} />{vi ? 'Tìm người để trò chuyện' : 'Find someone to talk to'}</button>}
        {!q && filter === 'groups' && <button type="button" className={s.quiet} onClick={onGroup}><UsersRound size={14} />{vi ? 'Tạo nhóm' : 'Create a group'}</button>}</div>}
      {list.map(c => <ConversationRow key={c.id} c={c} me={me} vi={vi} active={c.id === active} onOpen={onOpen} onError={setError} />)}
      {moreChats && !q && (filter === 'all' || filter === 'unread' || filter === 'groups') && <button type="button" className={s.moreButton} onClick={() => void moreConversations()} data-testid="msgr-more-chats">{vi ? 'Xem thêm' : 'Show more'}</button>}
    </div>
  </>;
}

/** One person in a list. The row opens their card; the buttons act at once. */
function PersonLine({ p, vi, onPerson, children }: { p: MessengerPerson; vi: boolean; onPerson: (id: number) => void; children?: React.ReactNode }) {
  return <li className={s.personRow} data-testid={`msgr-person-${p.id}`}>
    <button type="button" className={s.personOpen} onClick={() => onPerson(p.id)} aria-label={vi ? `Xem hồ sơ của ${p.name}` : `See ${p.name}'s profile`} data-testid={`msgr-open-${p.id}`}>
      <Avatar name={p.name} src={p.avatarUrl} online={p.online} size={38} />
      <span className={s.personText}><b>{p.name}</b>{p.username && <em>@{p.username}</em>}</span>
    </button>
    <span className={s.personTools}>{children}</span>
  </li>;
}

function useActing(vi: boolean) {
  const [busy, setBusy] = useState<number | null>(null), [error, setError] = useState<string | null>(null);
  const act = useCallback(async (id: number, work: () => Promise<void>) => {
    setBusy(id); setError(null);
    try { await work(); return true; } catch (e) { setError(word(errorCode(e), vi)); return false; } finally { setBusy(null); }
  }, [vi]);
  return { busy, error, act };
}

function FriendsPanel({ vi, onChat, onPerson, onFind }: { vi: boolean; onChat: (id: number) => void; onPerson: (id: number) => void; onFind: () => void }) {
  const people = useMessenger(st => st.people), moreFriends = useMessenger(st => st.moreFriends), ready = useMessenger(st => st.ready);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const friends = useMemo(() => [...(q ? people.friends.filter(f => f.name.toLowerCase().includes(q) || f.username?.includes(q)) : people.friends)].sort((a, b) => Number(b.online) - Number(a.online)), [people.friends, q]);
  return <>
    <label className={s.search}><Search size={15} aria-hidden="true" /><input data-testid="msgr-filter-friends" value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Lọc bạn bè…' : 'Filter friends…'} aria-label={vi ? 'Lọc bạn bè' : 'Filter friends'} /></label>
    <div className={s.people}>
      {!ready && <div className={s.state}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div>}
      {ready && (friends.length ? <ul>{friends.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}><button type="button" className={s.small} onClick={() => onChat(p.id)} data-testid={`msgr-chat-${p.id}`}><MessageCircle size={14} />{vi ? 'Nhắn tin' : 'Message'}</button></PersonLine>)}</ul>
        : <div className={s.state} data-testid="msgr-no-friends"><p>{q ? (vi ? 'Không có bạn nào khớp.' : 'No friend matches.') : (vi ? 'Chưa có bạn bè. Khi hai người cùng theo dõi nhau trong Cộng đồng, hai bạn là bạn bè.' : 'No friends yet. When you both follow each other in Community, you are friends.')}</p>{!q && <button type="button" className={s.quiet} onClick={onFind}><UserPlus size={14} />{vi ? 'Tìm và kết bạn' : 'Find and add friends'}</button>}</div>)}
      {people.moreFriends && !q && <button type="button" className={s.moreButton} onClick={() => void moreFriends()} data-testid="msgr-more-friends">{vi ? 'Xem thêm' : 'Show more'}</button>}
    </div>
  </>;
}

function RequestsPanel({ vi, onOpen, onPerson }: { vi: boolean; onOpen: (id: string) => void; onPerson: (id: number) => void }) {
  const people = useMessenger(st => st.people), requests = useMessenger(st => st.requests), loadPeople = useMessenger(st => st.loadPeople), load = useMessenger(st => st.load), ready = useMessenger(st => st.ready);
  const { busy, error, act } = useActing(vi);
  const restricted = people.restricted ?? [];
  const nothing = !people.incoming.length && !requests.length && !people.outgoing.length && !people.blocked.length && !restricted.length;
  return <div className={s.people}>
    {error && <p className={s.inviteError} role="alert">{error}</p>}
    {!ready && <div className={s.state}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div>}
    {ready && nothing && <div className={s.state} data-testid="msgr-no-requests"><p>{vi ? 'Không có lời mời nào.' : 'No requests.'}</p></div>}
    {requests.length > 0 && <><h3>{vi ? 'Tin nhắn chờ' : 'Message requests'}</h3><div>{requests.map(c => <button type="button" key={c.id} className={s.item} onClick={() => onOpen(c.id)} data-testid={`msgr-request-${c.other?.id}`}>
      <Avatar name={titleOf(c)} src={c.other?.avatarUrl} />
      <span className={s.itemText}><b>{titleOf(c)}</b><span>{c.last?.body}</span></span>
      <span className={s.itemMeta}>{c.last && <time>{shortWhen(c.last.at, vi)}</time>}</span>
    </button>)}</div></>}
    {people.incoming.length > 0 && <><h3>{vi ? 'Lời mời kết bạn' : 'Friend requests'}</h3><ul>{people.incoming.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}>
      <button type="button" className={s.small} disabled={busy === p.id} onClick={() => void act(p.id, async () => { await messengerApi.addFriend(p.id); await loadPeople(); })} data-testid={`msgr-accept-${p.id}`}><Check size={14} />{vi ? 'Đồng ý' : 'Accept'}</button>
      <button type="button" className={s.smallQuiet} disabled={busy === p.id} onClick={() => void act(p.id, async () => { await messengerApi.declineFriend(p.id); await loadPeople(); })} data-testid={`msgr-decline-${p.id}`}>{vi ? 'Từ chối' : 'Decline'}</button>
    </PersonLine>)}</ul></>}
    {people.outgoing.length > 0 && <><h3>{vi ? 'Đã gửi' : 'Sent'}</h3><ul>{people.outgoing.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}>
      <button type="button" className={s.smallQuiet} disabled={busy === p.id} onClick={() => void act(p.id, async () => { await messengerApi.removeFriend(p.id); await loadPeople(); })} data-testid={`msgr-cancel-${p.id}`}>{vi ? 'Huỷ' : 'Cancel'}</button>
    </PersonLine>)}</ul></>}
    {restricted.length > 0 && <><h3>{vi ? 'Đang hạn chế' : 'Restricted'}</h3><ul>{restricted.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}>
      <button type="button" className={s.smallQuiet} disabled={busy === p.id} onClick={() => void act(p.id, async () => { await messengerApi.unrestrict(p.id); await load(); })} data-testid={`msgr-unrestrict-${p.id}`}><EyeOff size={14} />{vi ? 'Bỏ hạn chế' : 'Unrestrict'}</button>
    </PersonLine>)}</ul></>}
    {people.blocked.length > 0 && <><h3>{vi ? 'Đã chặn' : 'Blocked'}</h3><ul>{people.blocked.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}>
      <button type="button" className={s.smallQuiet} disabled={busy === p.id} onClick={() => void act(p.id, async () => { await messengerApi.unblock(p.id); await loadPeople(); })} data-testid={`msgr-unblock-${p.id}`}>{vi ? 'Bỏ chặn' : 'Unblock'}</button>
    </PersonLine>)}</ul></>}
  </div>;
}

function SearchPanel({ vi, onChat, onPerson }: { vi: boolean; onChat: (id: number) => void; onPerson: (id: number) => void }) {
  const loadPeople = useMessenger(st => st.loadPeople);
  const [query, setQuery] = useState(''), [results, setResults] = useState<MessengerPerson[] | null>(null), [next, setNext] = useState<string | null>(null), [searching, setSearching] = useState(false);
  const { busy, error, act } = useActing(vi);
  useEffect(() => {
    const q = query.trim();
    if (q.replace(/^@/, '').length < 2) { setResults(null); setNext(null); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      void messengerApi.search(q).then(r => { if (live) { setResults(r.items); setNext(r.next); } }).catch(() => { if (live) { setResults([]); setNext(null); } }).finally(() => { if (live) setSearching(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const more = async () => {
    if (!next) return;
    try { const r = await messengerApi.search(query.trim(), next); setResults(list => [...(list ?? []), ...r.items.filter(x => !list?.some(y => y.id === x.id))]); setNext(r.next); } catch { /* The button stays. */ }
  };
  const change = (id: number, relation: MessengerPerson['relation'], work: () => Promise<void>) => act(id, async () => { await work(); setResults(list => list?.map(x => x.id === id ? { ...x, relation } : x) ?? null); void loadPeople(); });
  return <>
    <label className={s.search}><Search size={15} aria-hidden="true" /><input autoFocus data-testid="msgr-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tên hoặc @tên_người_dùng…' : 'Name or @username…'} aria-label={vi ? 'Tìm người' : 'Find people'} /></label>
    <div className={s.people}>
      {error && <p className={s.inviteError} role="alert">{error}</p>}
      {results === null && !searching && <div className={s.state} data-testid="msgr-search-hint"><p>{vi ? 'Gõ ít nhất 2 chữ để tìm theo tên, hoặc @ để tìm đúng tên người dùng.' : 'Type at least 2 letters to search by name, or @ for a username.'}</p></div>}
      {searching && results === null && <div className={s.state}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tìm' : 'Searching'} /></div>}
      {results && (results.length ? <ul data-testid="msgr-results">{results.map(p => <PersonLine key={p.id} p={p} vi={vi} onPerson={onPerson}>
        {p.relation === 'FRIEND' && <button type="button" className={s.small} onClick={() => onChat(p.id)} data-testid={`msgr-chat-${p.id}`}><MessageCircle size={14} />{vi ? 'Nhắn tin' : 'Message'}</button>}
        {p.relation === 'INCOMING' && <button type="button" className={s.small} disabled={busy === p.id} onClick={() => void change(p.id, 'FRIEND', () => messengerApi.addFriend(p.id))} data-testid={`msgr-accept-${p.id}`}><Check size={14} />{vi ? 'Đồng ý' : 'Accept'}</button>}
        {p.relation === 'OUTGOING' && <button type="button" className={s.smallQuiet} disabled={busy === p.id} onClick={() => void change(p.id, 'NONE', () => messengerApi.removeFriend(p.id))} data-testid={`msgr-cancel-${p.id}`}><Check size={14} />{vi ? 'Đã gửi · Huỷ' : 'Sent · Cancel'}</button>}
        {(p.relation === 'NONE' || !p.relation) && <>
          <button type="button" className={s.small} disabled={busy === p.id} onClick={() => void change(p.id, 'OUTGOING', () => messengerApi.addFriend(p.id))} data-testid={`msgr-add-${p.id}`}><UserPlus size={14} />{vi ? 'Kết bạn' : 'Add'}</button>
          <button type="button" className={s.smallQuiet} onClick={() => onChat(p.id)} aria-label={vi ? `Nhắn tin cho ${p.name}` : `Message ${p.name}`} data-testid={`msgr-chat-${p.id}`}><MessageCircle size={14} /></button>
        </>}
      </PersonLine>)}</ul> : <div className={s.state} data-testid="msgr-no-results"><p>{vi ? 'Không tìm thấy ai.' : 'Nobody found.'}</p></div>)}
      {next && <button type="button" className={s.moreButton} onClick={() => void more()} data-testid="msgr-more-results">{vi ? 'Xem thêm' : 'Show more'}</button>}
    </div>
  </>;
}

/** The person's own card: the name others find them by, who may write to them, and whether others see when they are here. */
function SettingsPanel({ vi, onClose }: { vi: boolean; onClose: () => void }) {
  const [me, setMe] = useState<MessengerMe | null>(null), [name, setName] = useState(''), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  const load = useMessenger(st => st.load);
  useEffect(() => { void messengerApi.me().then(m => { setMe(m); setName(m.username); }).catch(() => setError(word(null, vi))); }, [vi]);
  const save = async (patch: Partial<MessengerMe>) => {
    const before = me;
    // A choice shows at once; the server's answer confirms it or puts it back.
    if (patch.username === undefined) setMe(m => m && { ...m, ...patch });
    setBusy(true); setError(null); setSaved(false);
    try { const m = await messengerApi.updateMe(patch); setMe(m); setName(m.username); setSaved(true); if (patch.showActivity !== undefined) void load(); } catch (e) { setMe(before); setError(word(errorCode(e), vi)); } finally { setBusy(false); }
  };
  return <div className={s.settings} role="dialog" aria-label={vi ? 'Cài đặt Echo Messenger' : 'Echo Messenger settings'} data-testid="msgr-settings">
    <header><h3>{vi ? 'Cài đặt của bạn' : 'Your settings'}</h3><button type="button" className={s.iconButton} aria-label={vi ? 'Đóng' : 'Close'} onClick={onClose}><X size={16} /></button></header>
    {!me ? <div className={s.state}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div> : <>
      <form onSubmit={e => { e.preventDefault(); if (name.trim() && name.trim() !== me.username) void save({ username: name.trim() }); }}>
        <label htmlFor="msgr-username">{vi ? 'Tên người dùng' : 'Username'}</label>
        <div className={s.settingsRow}><span aria-hidden="true">@</span><input id="msgr-username" value={name} maxLength={24} autoComplete="off" spellCheck={false} onChange={e => setName(e.target.value.toLowerCase())} data-testid="msgr-username" /><button type="submit" className={s.small} disabled={busy || !name.trim() || name.trim() === me.username} data-testid="msgr-username-save">{vi ? 'Lưu' : 'Save'}</button></div>
      </form>
      <fieldset>
        <legend>{vi ? 'Ai có thể bắt đầu trò chuyện với bạn' : 'Who can start a conversation with you'}</legend>
        <label><input type="radio" name="msgr-policy" checked={me.messagePolicy === 'EVERYONE'} disabled={busy} onChange={() => void save({ messagePolicy: 'EVERYONE' })} data-testid="msgr-policy-everyone" />{vi ? 'Mọi người (người lạ vào mục Lời mời)' : 'Everyone (strangers go to Requests)'}</label>
        <label><input type="radio" name="msgr-policy" checked={me.messagePolicy === 'FRIENDS'} disabled={busy} onChange={() => void save({ messagePolicy: 'FRIENDS' })} data-testid="msgr-policy-friends" />{vi ? 'Chỉ bạn bè' : 'Friends only'}</label>
      </fieldset>
      <label className={s.settingsCheck}><input type="checkbox" checked={me.discoverable} disabled={busy} onChange={e => void save({ discoverable: e.target.checked })} data-testid="msgr-discoverable" />{vi ? 'Cho phép tìm thấy tôi theo tên' : 'Let people find me by name'}</label>
      <p className={s.note}>{vi ? 'Khi tắt, người khác chỉ tìm được bạn khi gõ đúng @tên_người_dùng.' : 'When off, people can only find you by your exact @username.'}</p>
      <label className={s.settingsCheck}><input type="checkbox" checked={me.showActivity} disabled={busy} onChange={e => void save({ showActivity: e.target.checked })} data-testid="msgr-show-activity" />{vi ? 'Hiển thị trạng thái hoạt động của tôi' : 'Show when I am active'}</label>
      <p className={s.note}>{vi ? 'Bạn bè thấy khi bạn đang hoạt động hoặc lần hoạt động gần nhất (trong 7 ngày). Khi tắt, bạn cũng không thấy trạng thái của người khác.' : 'Friends see when you are active, or when you last were (for 7 days). When off, you do not see other people\'s activity either.'}</p>
      {error && <p className={s.inviteError} role="alert">{error}</p>}
      {saved && !error && <p className={s.note} role="status" data-testid="msgr-settings-saved">{vi ? 'Đã lưu.' : 'Saved.'}</p>}
    </>}
  </div>;
}

export default function EchoMessenger({ initial, initialView, embedded = false, onEnterArena, portalHost, back }: { initial?: string | null; initialView?: MessengerView | null; embedded?: boolean; portalHost?: HTMLElement | null; onEnterArena?: (code: string) => void; back?: { href: string; label: string } }) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const router = useRouter();
  const conversations = useMessenger(st => st.conversations), requests = useMessenger(st => st.requests), aside = useMessenger(st => st.aside), unread = useMessenger(st => st.unread), messageRequests = useMessenger(st => st.messageRequests), friendRequests = useMessenger(st => st.friendRequests);
  const attach = useMessenger(st => st.attach), startWith = useMessenger(st => st.startWith), wantView = useMessenger(st => st.wantView), askView = useMessenger(st => st.askView);
  const [active, setActive] = useState<string | null>(initial ?? null), [tab, setTab] = useState<MessengerView>(initialView ?? 'chats'), [person, setPerson] = useState<number | null>(null), [settings, setSettings] = useState(false), [chatError, setChatError] = useState<string | null>(null);
  const [details, setDetails] = useState(false), [grouping, setGrouping] = useState(false);
  // The small host of the cards loads when the page has settled; this screen needs to know whose messages are whose at once.
  const { data: session } = useSession();
  const account = Number((session?.user as { id?: string | number } | undefined)?.id ?? 0);
  useEffect(() => { if (account) useMessenger.getState().bind(account); }, [account]);
  useEffect(() => attach(), [attach]);
  useEffect(() => { if (initial) { setActive(initial); setTab('chats'); } }, [initial]);
  useEffect(() => { if (wantView) { setTab(wantView); setActive(null); askView(null); } }, [wantView, askView]);
  const enter = useCallback((code: string) => { if (onEnterArena) onEnterArena(code); else requestArenaJoin(code, href => router.push(href)); }, [onEnterArena, router]);
  const current = conversations.find(c => c.id === active) ?? requests.find(c => c.id === active) ?? aside.ARCHIVED?.find(c => c.id === active) ?? aside.RESTRICTED?.find(c => c.id === active) ?? null;
  // A conversation that is no longer mine to see (left, removed) closes by itself once the lists say so.
  const ready = useMessenger(st => st.ready), rev = useMessenger(st => active ? st.rev[active] ?? 0 : 0);
  useEffect(() => { if (active && ready && !current && rev > 0) { setActive(null); setDetails(false); } }, [active, ready, current, rev]);
  const chat = async (userId: number) => {
    setChatError(null);
    try { const id = await startWith(userId); setActive(id); setTab('chats'); } catch (e) { setChatError(word(errorCode(e), vi)); }
  };
  const asked = messageRequests + friendRequests;
  const tabs: { id: MessengerView; vi: string; en: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'chats', vi: 'Trò chuyện', en: 'Chats', icon: <MessageCircle size={16} />, count: unread },
    { id: 'friends', vi: 'Bạn bè', en: 'Friends', icon: <Users size={16} /> },
    { id: 'requests', vi: 'Lời mời', en: 'Requests', icon: <Inbox size={16} />, count: asked },
    { id: 'search', vi: 'Tìm kiếm', en: 'Search', icon: <Search size={16} /> },
  ];
  return <div className={s.world} data-embedded={embedded || undefined} data-open={current ? '' : undefined} data-details={current && details ? '' : undefined} data-testid="msgr-root"><div className={s.frame}>
    <aside className={s.side} aria-label="Echo Messenger">
      <div className={s.sideHead}>
        <div className={s.sideTitle}>
          {back && <Link href={back.href} className={s.iconButton} aria-label={back.label} title={back.label} data-testid="msgr-back-link"><ArrowLeft size={18} /></Link>}
          <h2>Echo Messenger</h2>
          <button type="button" className={s.iconButton} aria-label={vi ? 'Tạo nhóm trò chuyện' : 'Create a group'} title={vi ? 'Tạo nhóm' : 'New group'} onClick={() => setGrouping(true)} data-testid="msgr-new-group"><UsersRound size={18} /></button>
          <button type="button" className={s.iconButton} aria-label={vi ? 'Cài đặt' : 'Settings'} aria-expanded={settings} onClick={() => setSettings(v => !v)} data-testid="msgr-settings-open"><Settings size={17} /></button>
        </div>
        <div className={s.tabs} role="tablist">
          {tabs.map(t => <button type="button" role="tab" key={t.id} aria-selected={tab === t.id} onClick={() => setTab(t.id)} data-testid={`msgr-tab-${t.id}`}>{t.icon}<span>{vi ? t.vi : t.en}</span>{!!t.count && t.count > 0 && <em>{t.count > 99 ? '99+' : t.count}</em>}</button>)}
        </div>
      </div>
      {chatError && <p className={s.inviteError} role="alert" style={{ margin: '0 12px 8px' }}>{chatError}</p>}
      {tab === 'chats' && <ChatsPanel vi={vi} active={active} onOpen={setActive} onFind={() => setTab('search')} onGroup={() => setGrouping(true)} />}
      {tab === 'friends' && <FriendsPanel vi={vi} onChat={id => void chat(id)} onPerson={setPerson} onFind={() => setTab('search')} />}
      {tab === 'requests' && <RequestsPanel vi={vi} onOpen={setActive} onPerson={setPerson} />}
      {tab === 'search' && <SearchPanel vi={vi} onChat={id => void chat(id)} onPerson={setPerson} />}
      {settings && <SettingsPanel vi={vi} onClose={() => setSettings(false)} />}
    </aside>
    {current ? <Thread key={current.id} conversation={current} vi={vi} details={details} onDetails={() => setDetails(v => !v)} onBack={() => { setActive(null); setDetails(false); }} onEnter={enter} onPerson={setPerson} /> : <section className={s.welcome}>
      <span aria-hidden="true"><Send size={30} /></span>
      <h3>{vi ? 'Chọn một cuộc trò chuyện' : 'Pick a conversation'}</h3>
      <p>{vi ? 'Nhắn tin với bạn bè và nhóm, gửi ảnh và tệp, mời nhau vào Speaking Arena và lưu từ hay thành thẻ từ vựng.' : 'Write to friends and groups, share pictures and files, invite each other to Speaking Arena and keep useful words as flashcards.'}</p>
      <button type="button" className={s.quiet} onClick={() => setGrouping(true)}><UsersRound size={15} />{vi ? 'Tạo nhóm trò chuyện' : 'Create a group'}</button>
    </section>}
    {current && details && <ConversationDetails key={'d' + current.id} conversation={current} vi={vi} onClose={() => setDetails(false)} onPerson={setPerson} onGone={() => { setActive(null); setDetails(false); }} />}
    {grouping && <GroupDialog vi={vi} onClose={() => setGrouping(false)} onDone={made => { setGrouping(false); if (made) { setActive(made.id); setTab('chats'); } }} />}
    {person !== null && <PersonCard portalHost={portalHost} userId={person} onClose={() => setPerson(null)} onChat={id => { setActive(id); setTab('chats'); }} />}
  </div></div>;
}
