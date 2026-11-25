'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Ban, Check, EyeOff, Flame, Loader2, MessageCircle, UserCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { messengerApi } from '@/services/messengerApi';
import { requestOpenMessenger } from '@/lib/messenger/bus';
import { errorCode, useMessenger } from '@/lib/messenger/store';
import { activityLine } from '@/lib/messenger/chatKit';
import type { MessengerProfile } from '@/types/messenger';
import s from './messenger.module.css';

export const PERSON_WORDS: Record<string, [string, string]> = {
  RATE_LIMIT: ['Bạn đang thao tác hơi nhanh, chờ một lát rồi thử lại.', 'You are going quickly: wait a moment and try again.'],
  REQUEST_DECLINED: ['Bạn chưa thể gửi lại lời mời cho người này lúc này.', 'You cannot send this person another request just now.'],
  UNAVAILABLE: ['Hiện không thể kết nối với người này.', 'This person cannot be reached right now.'],
  FRIENDS_ONLY: ['Người này chỉ nhận tin nhắn từ bạn bè. Hãy gửi lời mời kết bạn trước.', 'This person only accepts messages from friends. Send a friend request first.'],
  BLOCKED_BY_ME: ['Bạn đã chặn người này. Bỏ chặn để nhắn tiếp.', 'You blocked this person. Unblock to write again.'],
  REQUEST_TO_ANSWER: ['Người này đang chờ bạn trả lời trong mục Lời mời.', 'This person is waiting for your answer in Requests.'],
  USER_NOT_FOUND: ['Không tìm thấy người này.', 'This person could not be found.'],
};
export const personWord = (code: string, vi: boolean) => { const w = PERSON_WORDS[code] ?? ['Chưa thực hiện được, thử lại nhé.', 'That did not work. Try again.']; return vi ? w[0] : w[1]; };

/**
 * One person, wherever they were found: in the Messenger, in a Speaking Arena room, in Community. What can be done with them follows the server's answer, never a guess made here.
 * Nothing is fetched before someone opens it.
 */
export default function PersonCard({ userId, name, onClose, onChat, portalHost }: { userId: number; portalHost?: HTMLElement | null; name?: string; onClose: () => void; onChat?: (conversationId: string) => void }) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const router = useRouter();
  const startWith = useMessenger(st => st.startWith), skew = useMessenger(st => st.skew), reload = useMessenger(st => st.load);
  const [p, setP] = useState<MessengerProfile | null>(null), [gone, setGone] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async () => {
    try { setP(await messengerApi.profile(userId)); } catch { setGone(true); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); was?.focus?.({ preventScroll: true }); };
  }, [onClose]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); await load(); } catch (e) { setError(personWord(errorCode(e), vi)); } finally { setBusy(false); }
  };
  const chat = async () => {
    setBusy(true); setError(null);
    try {
      const id = await startWith(userId);
      onClose();
      if (onChat) onChat(id); else requestOpenMessenger(id, href => router.push(href));
    } catch (e) { setError(personWord(errorCode(e), vi)); setBusy(false); }
  };
  const relation = p?.person.relation;
  const initial = (p?.person.name ?? name ?? '?').trim().charAt(0).toUpperCase();
  const card = <div className={s.personBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} data-testid="person-card-backdrop">
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={p?.person.name ?? name ?? (vi ? 'Hồ sơ' : 'Profile')} className={s.personCard} data-testid="person-card" data-relation={relation ?? undefined}>
      <button type="button" className={s.personClose} aria-label={vi ? 'Đóng' : 'Close'} onClick={onClose} data-testid="person-card-close"><X size={17} /></button>
      {gone ? <p className={s.personNote} role="alert">{personWord('USER_NOT_FOUND', vi)}</p> : <>
        <div className={s.personHead}>
          <span className={s.personAvatar} data-online={p?.person.online || undefined}>{p?.person.avatarUrl ? <img src={p.person.avatarUrl} alt="" width={72} height={72} /> : <span aria-hidden="true">{initial}</span>}<i aria-hidden="true" /></span>
          <div className={s.personWho}>
            <b>{p?.person.name ?? name ?? ''}</b>
            {p?.person.username && <span data-testid="person-card-username">@{p.person.username}</span>}
            {p && !p.self && activityLine(p.person, vi, Date.now() + skew) && <em data-online={p.person.online || undefined} data-testid="person-card-activity">{activityLine(p.person, vi, Date.now() + skew)}</em>}
          </div>
        </div>
        {!p ? <div className={s.personLoading}><Loader2 size={20} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div> : <>
          <dl className={s.personFacts}>
            {p.cefrLevel && <div><dt>{vi ? 'Trình độ' : 'Level'}</dt><dd>{p.cefrLevel}</dd></div>}
            <div><dt>{vi ? 'Chuỗi ngày' : 'Streak'}</dt><dd><Flame size={14} aria-hidden="true" />{p.streakDays}</dd></div>
            <div><dt>{vi ? 'Người theo dõi' : 'Followers'}</dt><dd>{p.followers}</dd></div>
            <div><dt>{vi ? 'Đang theo dõi' : 'Following'}</dt><dd>{p.following}</dd></div>
          </dl>
          {error && <p className={s.personError} role="alert">{error}</p>}
          {p.self ? <p className={s.personNote}>{vi ? 'Đây là bạn.' : 'This is you.'}</p> : <div className={s.personActions}>
            {relation === 'FRIEND' && <span className={s.personState} data-testid="person-card-friends"><UserCheck size={15} />{vi ? 'Bạn bè' : 'Friends'}</span>}
            {relation === 'NONE' && <button type="button" className={s.primary} disabled={busy} onClick={() => void act(() => messengerApi.addFriend(userId))} data-testid="person-card-add"><UserPlus size={15} />{vi ? 'Kết bạn' : 'Add friend'}</button>}
            {relation === 'OUTGOING' && <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.removeFriend(userId))} data-testid="person-card-cancel"><Check size={15} />{vi ? 'Đã gửi lời mời · Huỷ' : 'Request sent · Cancel'}</button>}
            {relation === 'INCOMING' && <>
              <button type="button" className={s.primary} disabled={busy} onClick={() => void act(() => messengerApi.addFriend(userId))} data-testid="person-card-accept"><Check size={15} />{vi ? 'Đồng ý kết bạn' : 'Accept'}</button>
              <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.declineFriend(userId))} data-testid="person-card-decline">{vi ? 'Từ chối' : 'Decline'}</button>
            </>}
            {relation !== 'BLOCKED' && <button type="button" className={relation === 'FRIEND' ? s.primary : s.quiet} disabled={busy || (!!p.refused && p.refused !== 'REQUEST_TO_ANSWER')} title={p.refused ? personWord(p.refused, vi) : undefined} onClick={() => void chat()} data-testid="person-card-chat"><MessageCircle size={15} />{vi ? 'Nhắn tin' : 'Message'}</button>}
            {relation === 'FRIEND' && <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.removeFriend(userId))} data-testid="person-card-remove"><UserMinus size={15} />{vi ? 'Huỷ kết bạn' : 'Unfriend'}</button>}
            {relation !== 'BLOCKED' && <button type="button" className={s.quiet} disabled={busy} aria-pressed={!!p.restricted} title={vi ? 'Tin nhắn của họ nằm riêng và không báo cho bạn; họ không thấy khi bạn đã đọc hay đang hoạt động. Họ không được báo.' : 'Their messages wait aside without notifying you; they do not see when you have read or are active. They are not told.'}
              onClick={() => void act(async () => { await (p.restricted ? messengerApi.unrestrict(userId) : messengerApi.restrict(userId)); void reload(); })} data-testid="person-card-restrict"><EyeOff size={15} />{p.restricted ? (vi ? 'Bỏ hạn chế' : 'Unrestrict') : (vi ? 'Hạn chế' : 'Restrict')}</button>}
            {relation === 'BLOCKED'
              ? <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.unblock(userId))} data-testid="person-card-unblock"><Ban size={15} />{vi ? 'Bỏ chặn' : 'Unblock'}</button>
              : <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.block(userId))} data-testid="person-card-block"><Ban size={15} />{vi ? 'Chặn' : 'Block'}</button>}
            {p.refused === 'FRIENDS_ONLY' && <p className={s.personNote}>{personWord('FRIENDS_ONLY', vi)}</p>}
          </div>}
        </>}
      </>}
    </div>
  </div>;
  return createPortal(card, portalHost ?? document.body);
}
