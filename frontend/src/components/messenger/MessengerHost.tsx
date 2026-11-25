'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, LogIn, MessageCircle, Mic, UserPlus, Users, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { messengerApi } from '@/services/messengerApi';
import { requestArenaJoin, requestOpenMessenger } from '@/lib/messenger/bus';
import { errorCode, useMessenger, type Card, type MessengerView } from '@/lib/messenger/store';
import s from './messenger.module.css';

/**
 * What the Messenger shows outside itself, on every page of a signed-in account: a small card for a new message, a request or an invitation. An invitation is answered here or
 * left alone; nobody is moved anywhere without saying yes. A running exam or practice is never interrupted: what came waits on the badge and the bell.
 */
const QUIET = /^\/exams\/.*\/(attempts?|practice)|^\/listening\/[^/]+\/practice|^\/games\/(?!$)/;

function CardView({ card, vi }: { card: Card; vi: boolean }) {
  const router = useRouter();
  const dismiss = useMessenger(st => st.dismiss), answer = useMessenger(st => st.answer), askView = useMessenger(st => st.askView);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // A message passes; an invitation stays for as long as it can be answered.
    const until = card.kind === 'message' ? 7000 : card.kind === 'invite' ? new Date(card.invite.expiresAt).getTime() - Date.now() : card.kind === 'declined' ? 8000 : card.kind === 'accepted' ? 60000 : 20000;
    const id = window.setTimeout(() => dismiss(card.key), Math.max(1000, until));
    return () => clearTimeout(id);
  }, [card, dismiss]);
  const openChat = (conversationId: string | null) => { dismiss(card.key); requestOpenMessenger(conversationId, href => router.push(href)); };
  const openView = (view: MessengerView) => { dismiss(card.key); askView(view); requestOpenMessenger(null, () => router.push(`/community/messages?view=${view}`)); };
  const close = <button type="button" className={s.cardClose} aria-label={vi ? 'Đóng' : 'Close'} onClick={() => dismiss(card.key)}><X size={15} /></button>;
  if (card.kind === 'message') return <div className={s.card} role="status" data-testid="msgr-card-message">
    <span className={s.cardIcon} aria-hidden="true"><MessageCircle size={18} /></span>
    <button type="button" onClick={() => openChat(card.conversationId)} style={{ all: 'unset', cursor: 'pointer', minWidth: 0 }}><b>{card.name || 'Echo Messenger'}</b><p>{card.text}</p></button>
    {close}
  </div>;
  if (card.kind === 'message-request') return <div className={s.card} role="status" data-testid="msgr-card-message-request">
    <span className={s.cardIcon} aria-hidden="true"><MessageCircle size={18} /></span>
    <div style={{ minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'muốn nhắn tin cho bạn.' : 'would like to message you.'}</p></div>
    {close}
    <div className={s.cardActions}><button type="button" className={s.primary} onClick={() => openView('requests')} data-testid="msgr-card-see-request">{vi ? 'Xem lời mời' : 'See request'}</button></div>
  </div>;
  if (card.kind === 'request-accepted') return <div className={s.card} role="status" data-testid="msgr-card-request-accepted">
    <span className={s.cardIcon} aria-hidden="true"><MessageCircle size={18} /></span>
    <button type="button" onClick={() => openChat(card.conversationId)} style={{ all: 'unset', cursor: 'pointer', minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'đã đồng ý trò chuyện với bạn.' : 'accepted your message.'}</p></button>
    {close}
  </div>;
  if (card.kind === 'friend-request') {
    const act = async (work: () => Promise<void>) => {
      setBusy(true); setError(null);
      try { await work(); dismiss(card.key); } catch { setError(vi ? 'Chưa trả lời được, thử lại nhé.' : 'Could not answer. Try again.'); } finally { setBusy(false); }
    };
    return <div className={s.card} role="alertdialog" aria-label={vi ? 'Lời mời kết bạn' : 'Friend request'} data-testid="msgr-card-friend-request">
      <span className={s.cardIcon} aria-hidden="true"><UserPlus size={18} /></span>
      <div style={{ minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'gửi cho bạn lời mời kết bạn.' : 'sent you a friend request.'}</p>{error && <p role="alert">{error}</p>}</div>
      {close}
      <div className={s.cardActions}>
        <button type="button" className={s.primary} disabled={busy} onClick={() => void act(() => messengerApi.addFriend(card.userId))} data-testid="msgr-card-friend-accept"><Check size={15} />{vi ? 'Đồng ý' : 'Accept'}</button>
        <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => messengerApi.declineFriend(card.userId))} data-testid="msgr-card-friend-decline">{vi ? 'Từ chối' : 'Decline'}</button>
      </div>
    </div>;
  }
  if (card.kind === 'friend-accepted') return <div className={s.card} role="status" data-testid="msgr-card-friend-accepted">
    <span className={s.cardIcon} aria-hidden="true"><Users size={18} /></span>
    <button type="button" onClick={() => openView('friends')} style={{ all: 'unset', cursor: 'pointer', minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'đã đồng ý kết bạn với bạn.' : 'accepted your friend request.'}</p></button>
    {close}
  </div>;
  const invite = card.invite;
  const say = (code: string) => vi ? (code === 'INVITE_EXPIRED' ? 'Lời mời đã hết hạn.' : code === 'VOICE_UNAVAILABLE' ? 'Speaking Arena tạm thời chưa sẵn sàng.' : 'Chưa trả lời được, thử lại nhé.') : (code === 'INVITE_EXPIRED' ? 'The invitation expired.' : code === 'VOICE_UNAVAILABLE' ? 'Speaking Arena is not available right now.' : 'Could not answer. Try again.');
  const respond = async (what: 'accept' | 'decline') => {
    setBusy(true); setError(null);
    try {
      const next = await answer(invite, what);
      if (what === 'accept' && next?.code) requestArenaJoin(next.code, href => router.push(href));
    } catch (e) { setError(say(errorCode(e))); }
    finally { setBusy(false); }
  };
  if (card.kind === 'invite') return <div className={s.card} role="alertdialog" aria-label={vi ? 'Lời mời Speaking Arena' : 'Speaking Arena invitation'} data-testid="msgr-card-invite">
    <span className={s.cardIcon} aria-hidden="true"><Mic size={18} /></span>
    <div style={{ minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'mời bạn vào phòng nói riêng trong Speaking Arena.' : 'invites you to a private room in Speaking Arena.'}</p>{error && <p role="alert">{error}</p>}</div>
    <button type="button" className={s.cardClose} aria-label={vi ? 'Để sau' : 'Later'} onClick={() => dismiss(card.key)}><X size={15} /></button>
    <div className={s.cardActions}>
      <button type="button" className={s.primary} disabled={busy} onClick={() => void respond('accept')} data-testid="msgr-card-accept"><Check size={15} />{vi ? 'Nhận lời' : 'Accept'}</button>
      <button type="button" className={s.quiet} disabled={busy} onClick={() => void respond('decline')} data-testid="msgr-card-decline">{vi ? 'Từ chối' : 'Decline'}</button>
      <button type="button" className={s.quiet} onClick={() => openChat(card.conversationId)}>{vi ? 'Mở trò chuyện' : 'Open chat'}</button>
    </div>
  </div>;
  if (card.kind === 'accepted') return <div className={s.card} role="alertdialog" aria-label={vi ? 'Lời mời đã được nhận' : 'Invitation accepted'} data-testid="msgr-card-accepted">
    <span className={s.cardIcon} aria-hidden="true"><Mic size={18} /></span>
    <div style={{ minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'đã nhận lời. Phòng của hai bạn đã sẵn sàng.' : 'accepted. Your room is ready.'}</p></div>
    {close}
    <div className={s.cardActions}><button type="button" className={s.primary} onClick={() => { dismiss(card.key); requestArenaJoin(invite.code as string, href => router.push(href)); }} data-testid="msgr-card-enter"><LogIn size={15} />{vi ? 'Vào phòng' : 'Enter the room'}</button></div>
  </div>;
  return <div className={s.card} role="status" data-testid="msgr-card-declined">
    <span className={s.cardIcon} aria-hidden="true"><Mic size={18} /></span>
    <div style={{ minWidth: 0 }}><b>{card.name}</b><p>{vi ? 'chưa thể nhận lời lần này.' : 'cannot join this time.'}</p></div>
    {close}
  </div>;
}

export default function MessengerHost({ account }: { account: number }) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const pathname = usePathname() ?? '';
  const cards = useMessenger(st => st.cards), viewing = useMessenger(st => st.viewing);
  useEffect(() => {
    const st = useMessenger.getState();
    st.bind(account);
    void st.boot();
  }, [account]);
  // A card about the conversation already on screen says nothing new. Neither does a message card on a page that must not be disturbed.
  const shown = QUIET.test(pathname) ? [] : cards.filter(c => !(c.kind === 'message' && c.conversationId === viewing));
  if (!shown.length) return null;
  return <div className={s.cards} data-testid="msgr-cards">{shown.slice(-3).map(c => <CardView key={c.key} card={c} vi={vi} />)}</div>;
}
