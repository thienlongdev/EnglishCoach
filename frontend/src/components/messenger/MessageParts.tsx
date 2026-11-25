'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, CornerUpLeft, Download, FileText, Image as ImageIcon, Layers, Loader2, LogIn, Mic, MoreHorizontal, Plus, RotateCw, Search, SmilePlus, Undo2, Users, X } from 'lucide-react';
import { attachmentUrl, messengerApi } from '@/services/messengerApi';
import { errorCode, useMessenger } from '@/lib/messenger/store';
import { EMOJI_GROUPS, QUICK_REACTIONS, fileSize, mentionSegments, recentEmoji, rememberEmoji, searchEmoji, themeName } from '@/lib/messenger/chatKit';
import type { ArenaInvite, Attachment, ChatMessage, InviteMode, ReactionPeople } from '@/types/messenger';
import s from './messenger.module.css';

export const MODES: { id: InviteMode; vi: string; en: string }[] = [
  { id: 'FREE', vi: 'Trò chuyện tự do', en: 'Free conversation' },
  { id: 'GUIDED', vi: 'Có chủ đề gợi ý', en: 'With guided prompts' },
  { id:'TEAM',vi:'Đối thoại đồng đội',en:'Team conversation' },
  { id: 'DUEL', vi: 'Đối thoại đôi', en: 'Speaking duel' },
];
export const clock = (at: string, locale: string) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));

/** A person's picture, or a group's: the picture when there is one, the first letter when not. The dot is shown only when the server said the person is online. */
export function Avatar({ name, src, online, size = 40, group = false }: { name: string; src?: string | null; online?: boolean; size?: number; group?: boolean }) {
  const letter = name.trim().charAt(0).toUpperCase() || '?';
  return <span className={s.avatar} style={{ width: size, height: size, fontSize: size * .4 }} data-online={online || undefined} data-group={group || undefined}>
    {src ? <img src={src} alt="" width={size} height={size} loading="lazy" /> : group ? <Users size={size * .46} aria-hidden="true" /> : <span aria-hidden="true">{letter}</span>}
    <i aria-hidden="true" />
  </span>;
}

/** The system's own emoji, in groups, with a search by a few everyday words and the ones used lately. Nothing is downloaded for it. */
export function EmojiPicker({ account, vi, onPick, onClose, compact = false }: { account: number; vi: boolean; onPick: (emoji: string) => void; onClose: () => void; compact?: boolean }) {
  const [query, setQuery] = useState(''), [group, setGroup] = useState('smileys');
  const recent = useMemo(() => recentEmoji(account), [account]);
  const root = useRef<HTMLDivElement | null>(null), input = useRef<HTMLInputElement | null>(null);
  const found = useMemo(() => searchEmoji(query), [query]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // After this click: the button that opened it must not close it at once.
    const t = window.setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const pick = (emoji: string) => { rememberEmoji(account, emoji); onPick(emoji); };
  // Arrow keys move among the emoji like a grid of buttons; Tab leaves it as usual.
  const onKey = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const cells = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-emoji]') ?? []);
    const at = cells.indexOf(document.activeElement as HTMLElement);
    if (at < 0) { if (e.key === 'ArrowDown') { e.preventDefault(); cells[0]?.focus(); } return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 8 : -8;
    const next = cells[at + step];
    if (next) { e.preventDefault(); next.focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); input.current?.focus(); }
  };
  const cell = (emoji: string, key: string) => <button type="button" key={key} data-emoji="" className={s.emojiCell} onClick={() => pick(emoji)} aria-label={emoji}>{emoji}</button>;
  const shown = EMOJI_GROUPS.find(g => g.id === group) ?? EMOJI_GROUPS[0];
  return <div ref={root} className={s.emojiPicker} data-compact={compact || undefined} role="dialog" aria-label={vi ? 'Chọn biểu tượng cảm xúc' : 'Choose an emoji'} data-testid="msgr-emoji-picker" onKeyDown={onKey}>
    <label className={s.emojiSearch}><Search size={14} aria-hidden="true" /><input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm biểu tượng cảm xúc' : 'Search emoji'} aria-label={vi ? 'Tìm biểu tượng cảm xúc' : 'Search emoji'} data-testid="msgr-emoji-search" /></label>
    <div className={s.emojiScroll}>
      {query.trim() ? (found.length ? <div className={s.emojiGrid}>{found.map(e => cell(e, 'f' + e))}</div> : <p className={s.note}>{vi ? 'Không thấy biểu tượng phù hợp.' : 'No emoji matches.'}</p>) : <>
        {recent.length > 0 && <><h4>{vi ? 'Dùng gần đây' : 'Recently used'}</h4><div className={s.emojiGrid}>{recent.map(e => cell(e, 'r' + e))}</div></>}
        <h4>{vi ? shown.vi : shown.en}</h4>
        <div className={s.emojiGrid}>{shown.items.split(' ').map(e => cell(e, shown.id + e))}</div>
      </>}
    </div>
    <div className={s.emojiTabs} role="tablist" aria-label={vi ? 'Nhóm biểu tượng' : 'Emoji groups'}>
      {EMOJI_GROUPS.map(g => <button type="button" role="tab" key={g.id} aria-selected={g.id === group && !query.trim()} title={vi ? g.vi : g.en} aria-label={vi ? g.vi : g.en} onClick={() => { setQuery(''); setGroup(g.id); }}>{g.icon}</button>)}
    </div>
  </div>;
}

/** Pictures of a message, one at a time, as large as the window allows. Arrows and Escape work; the page behind does not move. */
export function Lightbox({ items, index, vi, onClose }: { items: Attachment[]; index: number; vi: boolean; onClose: () => void }) {
  const [at, setAt] = useState(index);
  const root = useRef<HTMLDivElement | null>(null);
  const item = items[Math.max(0, Math.min(items.length - 1, at))];
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowRight') setAt(n => Math.min(items.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setAt(n => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); was?.focus?.({ preventScroll: true }); };
  }, [items.length, onClose]);
  if (!item) return null;
  return <div ref={root} tabIndex={-1} className={s.lightbox} role="dialog" aria-modal="true" aria-label={item.name} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} data-testid="msgr-lightbox">
    <img src={item.localUrl ?? attachmentUrl(item.id)} alt={item.name} />
    <div className={s.lightboxBar}>
      <span>{item.name}{items.length > 1 ? ` · ${at + 1}/${items.length}` : ''}</span>
      {!item.localUrl && <a href={attachmentUrl(item.id)} download={item.name} aria-label={vi ? 'Tải ảnh về' : 'Download'}><Download size={17} /></a>}
      <button type="button" onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'}><X size={18} /></button>
    </div>
    {at > 0 && <button type="button" className={s.lightboxPrev} onClick={() => setAt(at - 1)} aria-label={vi ? 'Ảnh trước' : 'Previous'}><ChevronLeft size={22} /></button>}
    {at < items.length - 1 && <button type="button" className={s.lightboxNext} onClick={() => setAt(at + 1)} aria-label={vi ? 'Ảnh sau' : 'Next'}><ChevronRight size={22} /></button>}
  </div>;
}

function InviteCard({ message, me, vi, onEnter, word }: { message: ChatMessage; me: number; vi: boolean; onEnter: (code: string) => void; word: (code: string | null | undefined) => string }) {
  const answer = useMessenger(st => st.answer);
  const invite = message.invite as ArenaInvite;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const expired = invite.status === 'EXPIRED' || (invite.status === 'PENDING' && new Date(invite.expiresAt).getTime() < Date.now());
  const status = expired ? 'EXPIRED' : invite.status, invited = invite.inviteeId === me;
  useEffect(() => { if (status !== 'PENDING') return; const id = window.setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(id); }, [status]);
  const left = Math.max(0, Math.ceil((new Date(invite.expiresAt).getTime() - Date.now()) / 1000));
  const act = async (what: 'accept' | 'decline' | 'cancel') => {
    setBusy(true); setError(null);
    try {
      const next = await answer(invite, what);
      if (what === 'accept' && next?.code) onEnter(next.code);
    } catch (e) { setError(word(errorCode(e))); }
    finally { setBusy(false); }
  };
  const mode = MODES.find(m => m.id === invite.mode);
  const line = status === 'ACCEPTED' ? (vi ? 'Đã nhận lời. Phòng riêng đã sẵn sàng.' : 'Accepted. Your private room is ready.')
    : status === 'DECLINED' ? (vi ? 'Lời mời đã bị từ chối.' : 'The invitation was declined.')
    : status === 'CANCELLED' ? (vi ? 'Lời mời đã huỷ.' : 'The invitation was cancelled.')
    : status === 'EXPIRED' ? (vi ? 'Lời mời đã hết hạn.' : 'The invitation expired.')
    : status === 'CLOSED' ? (vi ? 'Phòng này đã đóng. Hãy mời lại khi muốn nói tiếp.' : 'This room has closed. Invite again to talk more.')
    : invited ? (vi ? 'Mời bạn vào phòng nói riêng.' : 'Invites you to a private speaking room.')
    : (vi ? 'Đang chờ bạn ấy trả lời.' : 'Waiting for an answer.');
  return <div className={s.inviteCard} data-status={status} data-testid="msgr-invite">
    <span className={s.inviteIcon} aria-hidden="true"><Mic size={18} /></span>
    <div className={s.inviteText}>
      <b>Speaking Arena</b>
      <span>{vi ? mode?.vi : mode?.en}</span>
      <p>{line}{status === 'PENDING' && <em> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</em>}</p>
      {error && <p className={s.inviteError} role="alert">{error}</p>}
    </div>
    <div className={s.inviteActions}>
      {status === 'PENDING' && invited && <>
        <button type="button" className={s.primary} disabled={busy} onClick={() => void act('accept')} data-testid="msgr-invite-accept">{busy ? <Loader2 size={15} className={s.spin} /> : <Check size={15} />}{vi ? 'Nhận lời' : 'Accept'}</button>
        <button type="button" className={s.quiet} disabled={busy} onClick={() => void act('decline')} data-testid="msgr-invite-decline">{vi ? 'Từ chối' : 'Decline'}</button>
      </>}
      {status === 'PENDING' && !invited && <button type="button" className={s.quiet} disabled={busy} onClick={() => void act('cancel')} data-testid="msgr-invite-cancel">{vi ? 'Huỷ lời mời' : 'Cancel'}</button>}
      {status === 'ACCEPTED' && invite.code && <button type="button" className={s.primary} onClick={() => onEnter(invite.code as string)} data-testid="msgr-invite-enter"><LogIn size={15} />{vi ? 'Vào phòng' : 'Enter the room'}</button>}
    </div>
  </div>;
}

function SharedCard({ message, vi }: { message: ChatMessage; vi: boolean }) {
  const reading = message.kind === 'SHARE_READING', id = message.payload?.id;
  const href = reading ? `/reading?materialId=${id}` : `/flashcards?deck=${id}`;
  return <Link className={s.sharedCard} href={href} data-testid="msgr-shared">
    <span aria-hidden="true">{reading ? <BookOpen size={18} /> : <Layers size={18} />}</span>
    <span><b>{message.payload?.title ?? message.body}</b><em>{reading ? (vi ? 'Mở bài đọc' : 'Open the reading') : (vi ? 'Mở bộ thẻ' : 'Open the deck')}</em></span>
  </Link>;
}

/** What the conversation says about itself, in the reader's language. */
export function systemLine(m: ChatMessage, vi: boolean, me: number) {
  const p = m.payload ?? {}, who = m.senderId === me ? (vi ? 'Bạn' : 'You') : (p.actor || m.senderName || (vi ? 'Một thành viên' : 'A member')), names = p.names ?? '';
  switch (p.event) {
    case 'created': return vi ? `${who} đã tạo nhóm “${p.title ?? ''}”.` : `${who} created the group “${p.title ?? ''}”.`;
    case 'added': return vi ? `${who} đã thêm ${names} vào nhóm.` : `${who} added ${names} to the group.`;
    case 'removed': return vi ? `${who} đã mời ${names} ra khỏi nhóm.` : `${who} removed ${names} from the group.`;
    case 'left': return vi ? `${who} đã rời nhóm.` : `${who} left the group.`;
    case 'renamed': return vi ? `${who} đã đổi tên nhóm thành “${p.title ?? ''}”.` : `${who} renamed the group to “${p.title ?? ''}”.`;
    case 'theme': return vi ? `${who} đã đổi chủ đề thành ${themeName(p.theme, true)}.` : `${who} changed the theme to ${themeName(p.theme, false)}.`;
    case 'avatar': return vi ? `${who} đã đổi ảnh nhóm.` : `${who} changed the group picture.`;
    case 'role': return vi ? `${who} đã đổi vai trò của ${names}.` : `${who} changed the role of ${names}.`;
    default: return m.body;
  }
}

function Files({ m, vi, onImage }: { m: ChatMessage; vi: boolean; onImage: (index: number) => void }) {
  const images = (m.attachments ?? []).filter(a => a.kind === 'IMAGE'), files = (m.attachments ?? []).filter(a => a.kind === 'FILE');
  if (!images.length && !files.length) return null;
  return <div className={s.files}>
    {images.length > 0 && <div className={s.imageGrid} data-count={Math.min(4, images.length)}>
      {images.map((a, i) => {
        const ratio = a.width && a.height ? Math.max(.5, Math.min(2, a.width / a.height)) : 1;
        return <button type="button" key={a.id} className={s.imageCell} style={images.length === 1 ? { aspectRatio: String(ratio), width: Math.round(Math.min(340, 260 * Math.max(1, ratio))) } : undefined}
          onClick={() => onImage(i)} aria-label={vi ? `Xem ảnh ${a.name}` : `View picture ${a.name}`} data-testid="msgr-image">
          <img src={a.localUrl ?? attachmentUrl(a.id, a.thumb)} alt={a.name} loading="lazy" decoding="async" draggable={false} />
          {a.progress !== undefined && a.progress < 1 && <span className={s.uploading} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(a.progress * 100)}><i style={{ width: `${Math.round(a.progress * 100)}%` }} /></span>}
        </button>;
      })}
    </div>}
    {files.map(a => {
      const body = <><span className={s.fileIcon} aria-hidden="true"><FileText size={18} /></span><span className={s.fileText}><b>{a.name}</b><em>{fileSize(a.size)}{a.progress !== undefined && a.progress < 1 ? ` · ${Math.round(a.progress * 100)}%` : ''}</em></span>{!a.localUrl && a.progress === undefined && <Download size={16} aria-hidden="true" />}</>;
      return a.progress !== undefined ? <div key={a.id} className={s.fileCard} data-testid="msgr-file">{body}</div>
        : <a key={a.id} className={s.fileCard} href={attachmentUrl(a.id)} download={a.name} data-testid="msgr-file" aria-label={vi ? `Tải ${a.name}` : `Download ${a.name}`}>{body}</a>;
    })}
  </div>;
}

/**
 * One message. Its actions (react, reply, more) appear beside it when the pointer is over it, when it has the keyboard's focus, or after a long press on a touch
 * screen: they take no room in the conversation when not in use.
 */
export function MessageRow({ m, mine, me, group, joined, vi, canAct, status, word, onReply, onJump, onEnter, onPerson }: {
  m: ChatMessage; mine: boolean; me: number; group: boolean; joined: boolean; vi: boolean; canAct: boolean; status?: React.ReactNode; word: (code: string | null | undefined) => string;
  onReply: (m: ChatMessage) => void; onJump: (id: number) => void; onEnter: (code: string) => void; onPerson?: (id: number) => void;
}) {
  const react = useMessenger(st => st.react), unsend = useMessenger(st => st.unsend), send = useMessenger(st => st.send);
  const [open, setOpen] = useState<null | 'bar' | 'react' | 'picker' | 'more' | 'who'>(null), [light, setLight] = useState<number | null>(null), [who, setWho] = useState<ReactionPeople[] | null>(null), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const row = useRef<HTMLDivElement | null>(null), press = useRef<number | null>(null), line = useRef<HTMLDivElement | null>(null), stack = useRef<HTMLDivElement | null>(null);
  // The toolbar stands level with the bubble the reader sees: its centre on the first ~44 px of the bubble (or picture / card), measured from the rendered
  // geometry each time it appears — never on the middle of the whole stack, which reactions and files make taller.
  const level = () => {
    const first = stack.current?.firstElementChild as HTMLElement | null, l = line.current;
    if (!first || !l) return;
    l.style.setProperty('--act-y', `${Math.round(first.offsetTop + Math.min(first.offsetHeight, 44) / 2)}px`);
  };
  const locale = vi ? 'vi-VN' : 'en-GB';
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (row.current && !row.current.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(null); row.current?.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  if (m.kind === 'SYSTEM') return <p className={s.systemLine} data-testid="msgr-system" data-mid={m.id}>{systemLine(m, vi, me)}</p>;
  const real = !m.sending && !m.failed && !m.deleted;
  const act = async (work: () => Promise<void>) => { setError(null); try { await work(); } catch (e) { setError(word(errorCode(e))); } };
  const pick = (emoji: string) => { setOpen(null); void act(() => react(m, m.reactions?.some(r => r.mine && r.emoji === emoji) ? null : emoji)); };
  const copy = () => { setOpen(null); void navigator.clipboard?.writeText(m.body).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }).catch(() => { /* Nothing was copied; nothing is claimed. */ }); };
  const showWho = () => { setOpen('who'); setWho(null); void messengerApi.reactors(m.id).then(setWho).catch(() => setWho([])); };
  const images = (m.attachments ?? []).filter(a => a.kind === 'IMAGE');
  // A long press on a touch screen is the hover of a mouse.
  const touch = { onTouchStart: () => { press.current = window.setTimeout(() => { setOpen('bar'); press.current = null; }, 420); }, onTouchEnd: () => { if (press.current) clearTimeout(press.current); }, onTouchMove: () => { if (press.current) clearTimeout(press.current); } };
  const reply = m.replyTo;
  return <div ref={row} className={s.row} data-mine={mine || undefined} data-joined={joined || undefined} data-open={open ? '' : undefined} data-testid="msgr-message" data-kind={m.kind} data-mid={m.id} tabIndex={real ? 0 : undefined}
    onPointerEnter={real ? level : undefined} onFocus={real ? level : undefined}
    aria-label={real ? `${mine ? (vi ? 'Bạn' : 'You') : m.senderName ?? ''}: ${m.body || (vi ? 'tệp đính kèm' : 'attachment')}, ${clock(m.at, locale)}` : undefined}
    onContextMenu={real ? e => { e.preventDefault(); setOpen('more'); } : undefined} {...(real ? touch : {})}>
    {group && !mine && !joined && <span className={s.sender}>{m.senderName}</span>}
    {reply && <button type="button" className={s.quote} disabled={reply.deleted} onClick={() => onJump(reply.id)} data-testid="msgr-quote" aria-label={vi ? `Trả lời ${reply.senderName}: ${reply.text}. Bấm để đến tin nhắn gốc` : `Reply to ${reply.senderName}: ${reply.text}. Go to the original message`}>
      <CornerUpLeft size={12} aria-hidden="true" /><b>{reply.senderId === me ? (vi ? 'Bạn' : 'You') : reply.senderName}</b>
      <span>{reply.deleted ? (vi ? 'Tin nhắn không còn xem được' : 'Message no longer available') : reply.text || (reply.attachment === 'IMAGE' ? (vi ? 'Ảnh' : 'Photo') : reply.attachment === 'FILE' ? (vi ? 'Tệp đính kèm' : 'Attachment') : '')}</span>
    </button>}
    <div className={s.bubbleLine} ref={line}>
      <div className={s.bubbleStack} ref={stack}>
        {m.kind === 'ARENA_INVITE' && m.invite ? <InviteCard message={m} me={me} vi={vi} onEnter={onEnter} word={word} />
          : m.kind === 'SHARE_READING' || m.kind === 'SHARE_DECK' ? <SharedCard message={m} vi={vi} />
          : m.deleted ? <div className={s.bubble} data-deleted="">{vi ? 'Tin nhắn đã được thu hồi' : 'This message was unsent'}</div>
          : <>
            <Files m={m} vi={vi} onImage={setLight} />
            {m.body && <div className={s.bubble} data-bubble="" data-sending={m.sending || undefined} data-failed={m.failed ? '' : undefined} title={clock(m.at, locale)}>
              {m.payload?.mentions?.length ? mentionSegments(m.body, m.payload.mentions).map((g, i) => 'id' in g
                ? <button type="button" key={i} className={s.mention} data-me={g.id === me || undefined} onClick={e => { e.stopPropagation(); onPerson?.(g.id); }} data-testid="msgr-mention"
                  aria-label={vi ? `Xem hồ sơ ${g.text.slice(1)}` : `See ${g.text.slice(1)}'s profile`}>{g.text}</button>
                : <React.Fragment key={i}>{g.text}</React.Fragment>) : m.body}
            </div>}
          </>}
        {!!m.reactions?.length && <div className={s.reactions} data-testid="msgr-reactions">
          {m.reactions.map(r => <button type="button" key={r.emoji} data-mine={r.mine || undefined} disabled={!canAct} onClick={() => pick(r.emoji)}
            aria-label={vi ? `${r.emoji} ${r.count} người${r.mine ? ', có bạn. Bấm để bỏ' : '. Bấm để chọn'}` : `${r.emoji} ${r.count}${r.mine ? ', including you. Press to remove' : '. Press to add'}`} aria-pressed={r.mine}><span aria-hidden="true">{r.emoji}</span>{r.count > 1 && <em>{r.count}</em>}</button>)}
        </div>}
      </div>
      {real && <div className={s.actions} role="toolbar" aria-label={vi ? 'Thao tác với tin nhắn' : 'Message actions'} data-testid="msgr-actions">
        {canAct && <button type="button" aria-label={vi ? 'Bày tỏ cảm xúc' : 'React'} aria-expanded={open === 'react' || open === 'picker'} onClick={() => setOpen(open === 'react' ? null : 'react')} data-testid="msgr-act-react"><SmilePlus size={16} /></button>}
        {canAct && <button type="button" aria-label={vi ? 'Trả lời' : 'Reply'} onClick={() => { setOpen(null); onReply(m); }} data-testid="msgr-act-reply"><CornerUpLeft size={16} /></button>}
        <button type="button" aria-label={vi ? 'Thêm' : 'More'} aria-expanded={open === 'more'} onClick={() => setOpen(open === 'more' ? null : 'more')} data-testid="msgr-act-more"><MoreHorizontal size={16} /></button>
        {open === 'react' && <div className={s.quickReact} role="menu" data-testid="msgr-quick-react">
          {QUICK_REACTIONS.map(e => <button type="button" role="menuitem" key={e} data-mine={m.reactions?.some(r => r.mine && r.emoji === e) || undefined} onClick={() => pick(e)} aria-label={e}>{e}</button>)}
          <button type="button" role="menuitem" className={s.quickMore} onClick={() => setOpen('picker')} aria-label={vi ? 'Biểu tượng khác' : 'More emoji'} data-testid="msgr-react-more"><Plus size={16} /></button>
        </div>}
        {open === 'picker' && <div className={s.pickerAnchor}><EmojiPicker account={me} vi={vi} compact onPick={pick} onClose={() => setOpen(null)} /></div>}
        {open === 'more' && <div className={s.menu} role="menu" data-testid="msgr-more-menu">
          <span className={s.menuNote}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(m.at))}</span>
          {m.body && <button type="button" role="menuitem" onClick={copy} data-testid="msgr-copy"><Copy size={15} />{vi ? 'Sao chép' : 'Copy'}</button>}
          {!!m.reactions?.length && <button type="button" role="menuitem" onClick={showWho} data-testid="msgr-who"><SmilePlus size={15} />{vi ? 'Ai đã bày tỏ cảm xúc' : 'Who reacted'}</button>}
          {mine && m.kind === 'TEXT' && <button type="button" role="menuitem" data-danger="" onClick={() => { setOpen(null); void act(() => unsend(m)); }} data-testid="msgr-unsend"><Undo2 size={15} />{vi ? 'Thu hồi tin nhắn' : 'Unsend'}</button>}
        </div>}
        {open === 'who' && <div className={s.menu} role="dialog" aria-label={vi ? 'Ai đã bày tỏ cảm xúc' : 'Who reacted'} data-testid="msgr-who-list">
          {who === null ? <span className={s.menuNote}><Loader2 size={14} className={s.spin} /></span> : who.length ? who.map(g => <div key={g.emoji} className={s.whoGroup}><span aria-hidden="true">{g.emoji}</span><span>{g.people.map(p => p.id === me ? (vi ? 'Bạn' : 'You') : p.name).join(', ')}</span></div>) : <span className={s.menuNote}>{vi ? 'Chưa có ai.' : 'Nobody yet.'}</span>}
        </div>}
      </div>}
    </div>
    {copied && <span className={s.status} role="status">{vi ? 'Đã sao chép' : 'Copied'}</span>}
    {error && <span className={s.rowError} role="alert">{error}</span>}
    {m.failed && <button type="button" className={s.retry} onClick={() => void send(m.conversationId, m.body, m.ref)} data-testid="msgr-retry"><RotateCw size={13} />{word(m.failed)} {vi ? 'Gửi lại' : 'Send again'}</button>}
    {status}
    {light !== null && <Lightbox items={images} index={light} vi={vi} onClose={() => setLight(null)} />}
  </div>;
}

export const PictureIcon = ImageIcon;
