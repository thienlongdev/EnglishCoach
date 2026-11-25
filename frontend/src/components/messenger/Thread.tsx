'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Ban, BellOff, BookOpen, Check, CheckCheck, ChevronDown, ChevronLeft, CornerUpLeft, FileText, Info, Layers, Lightbulb, Loader2, Mic, Paperclip, Plus, RotateCw, Search, Send, Smile, X } from 'lucide-react';
import { apiClient } from '@/services/api-client';
import { getReadingMaterials } from '@/services/readingApi';
import { messengerApi } from '@/services/messengerApi';
import { publishTyping } from '@/lib/messenger/bus';
import { errorCode, titleOf, useMessenger, type PendingFile } from '@/lib/messenger/store';
import { ACCEPT, activityLine, fileSize, mentionMatches, mentionQuery, mentionSegments, mentionSpans, overLimit, pastedPictures, prepareFile } from '@/lib/messenger/chatKit';
import { QuickDictionaryPopover } from '@/components/features/dictionary/QuickDictionaryPopover';
import FlashcardSave from '@/components/study-space/FlashcardSave';
import { arenaPrompts } from '@/components/features/speaking/arena/arenaCopy';
import type { ChatMessage, Conversation, InviteMode, MessengerPerson } from '@/types/messenger';
import { Avatar, EmojiPicker, MODES, MessageRow, clock } from './MessageParts';
import s from './messenger.module.css';

export const WORDS: Record<string, [string, string]> = {
  NOT_FRIENDS: ['Hai bạn chưa kết bạn nên không thể nhắn thêm.', 'You are not friends, so you cannot send more.'],
  NOT_CONNECTED: ['Việc này cần người kia đồng ý trò chuyện trước.', 'This needs the other person to accept first.'],
  FRIENDS_ONLY: ['Người này chỉ nhận tin nhắn từ bạn bè. Hãy gửi lời mời kết bạn trước.', 'This person only accepts messages from friends. Send a friend request first.'],
  REQUEST_TO_ANSWER: ['Hãy trả lời lời mời trò chuyện của người này trước.', 'Answer this person\'s request first.'],
  REQUEST_LIMIT: ['Bạn đã gửi đủ 3 tin nhắn. Hãy chờ người này đồng ý.', 'You have sent 3 messages. Wait until this person accepts.'],
  REQUEST_CLOSED: ['Lời mời này đã được trả lời.', 'This request was already answered.'],
  REQUEST_DECLINED: ['Bạn chưa thể gửi lại lời mời cho người này lúc này.', 'You cannot send this person another request just now.'],
  USERNAME_TAKEN: ['Tên này đã có người dùng.', 'That name is taken.'],
  USERNAME_INVALID: ['Tên gồm 3–24 ký tự: chữ thường, số, dấu chấm hoặc gạch dưới.', 'Use 3–24 characters: lower-case letters, digits, dot or underscore.'],
  BLOCKED_BY_ME: ['Bạn đã chặn người này. Bỏ chặn để nhắn tiếp.', 'You blocked this person. Unblock to write again.'],
  UNAVAILABLE: ['Hiện không thể gửi tin cho người này.', 'This person cannot receive messages right now.'],
  RESTRICTED: ['Tài khoản của bạn đang bị hạn chế trong Cộng đồng.', 'Your account is restricted in Community.'],
  RATE_LIMIT: ['Bạn đang thao tác hơi nhanh, chờ một lát rồi thử lại.', 'You are going quickly: wait a moment and try again.'],
  MESSAGE_TOO_LONG: ['Tin nhắn quá dài (tối đa 2.000 ký tự).', 'That message is too long (2,000 characters at most).'],
  MESSAGE_NOT_FOUND: ['Tin nhắn này không còn xem được.', 'This message is no longer available.'],
  MESSAGE_GONE: ['Tin nhắn này đã được thu hồi.', 'This message was unsent.'],
  NOT_YOURS: ['Bạn chỉ thu hồi được tin nhắn của mình.', 'You can only unsend your own messages.'],
  INVITE_PENDING: ['Lời mời trước vẫn đang chờ trả lời.', 'Your last invitation is still waiting for an answer.'],
  INVITE_EXPIRED: ['Lời mời này đã hết hạn.', 'This invitation has expired.'],
  INVITE_CLOSED: ['Lời mời này đã được trả lời hoặc đã huỷ.', 'This invitation was already answered or cancelled.'],
  VOICE_UNAVAILABLE: ['Speaking Arena tạm thời chưa sẵn sàng.', 'Speaking Arena is not available right now.'],
  ARENA_FULL: ['Speaking Arena đang đầy, thử lại sau một lát.', 'Speaking Arena is full: try again shortly.'],
  ATTACHMENT_NOT_ALLOWED: ['Loại tệp này chưa được hỗ trợ. Bạn có thể gửi ảnh, PDF, Word, Excel, PowerPoint, TXT hoặc CSV.', 'This kind of file is not supported. You can send pictures, PDF, Word, Excel, PowerPoint, TXT or CSV.'],
  ATTACHMENT_TOO_LARGE: ['Tệp quá lớn. Ảnh tối đa 5 MB, tài liệu tối đa 10 MB, mỗi tin nhắn tối đa 20 MB.', 'Too large. Pictures up to 5 MB, documents up to 10 MB, 20 MB a message.'],
  ATTACHMENT_TOO_MANY: ['Mỗi tin nhắn gửi được tối đa 4 ảnh và 2 tài liệu.', 'A message can carry up to 4 pictures and 2 documents.'],
  ATTACHMENT_EMPTY: ['Tệp này trống.', 'This file is empty.'],
  ATTACHMENT_QUOTA: ['Bạn đã dùng hết dung lượng gửi tệp. Hãy thu hồi bớt tệp cũ hoặc thử lại sau.', 'You have used your file allowance. Unsend older files or try again later.'],
  ATTACHMENT_WAITING: ['Có quá nhiều tệp đang chờ gửi. Hãy gửi hoặc bỏ bớt.', 'Too many files are waiting. Send or remove some.'],
  ATTACHMENT_GONE: ['Tệp chờ quá lâu nên đã hết hạn. Bấm gửi lại để tải lên lần nữa.', 'The file waited too long. Send again to upload it once more.'],
  UPLOADS_BUSY: ['Máy chủ đang nhận nhiều tệp, thử lại sau giây lát.', 'The server is receiving many files: try again in a moment.'],
  STORAGE_FULL: ['Máy chủ tạm thời không nhận thêm tệp.', 'The server cannot take more files right now.'],
  STORAGE_UNAVAILABLE: ['Chưa lưu được tệp, thử lại nhé.', 'The file could not be stored. Try again.'],
  PIN_LIMIT: ['Bạn chỉ ghim được tối đa 5 cuộc trò chuyện.', 'You can pin up to 5 conversations.'],
  GROUP_MEMBER_NOT_ALLOWED: ['Bạn chỉ thêm được bạn bè của mình vào nhóm.', 'You can only add your own friends to a group.'],
  GROUP_FULL: ['Nhóm đã đủ 50 thành viên.', 'The group already has 50 members.'],
  GROUP_LIMIT: ['Bạn đang ở trong quá nhiều nhóm.', 'You are in too many groups.'],
  GROUP_TITLE_INVALID: ['Tên nhóm gồm 1–60 ký tự.', 'A group name has 1–60 characters.'],
  NOT_ALLOWED: ['Bạn không có quyền thực hiện việc này trong nhóm.', 'You are not allowed to do this in the group.'],
  CONVERSATION_NOT_FOUND: ['Cuộc trò chuyện này không còn nữa.', 'This conversation is no longer available.'],
  TOO_FAR: ['Tin nhắn gốc ở quá xa hoặc không còn xem được.', 'The original message is too far back or no longer available.'],
  UNAVAILABLE_ANY: ['Chưa gửi được. Kiểm tra mạng rồi thử lại.', 'Not sent. Check your connection and try again.'],
};
export const word = (code: string | null | undefined, vi: boolean) => { const w = WORDS[code ?? ''] ?? WORDS.UNAVAILABLE_ANY; return vi ? w[0] : w[1]; };

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const dayLabel = (at: string, vi: boolean) => {
  const d = new Date(at), now = new Date(), y = new Date(now.getTime() - 864e5);
  if (d.toDateString() === now.toDateString()) return vi ? 'Hôm nay' : 'Today';
  if (d.toDateString() === y.toDateString()) return vi ? 'Hôm qua' : 'Yesterday';
  return new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
};

/** A word chosen in a message: look it up, or keep it as a card. Both are the ordinary services. */
function SelectionTools({ text, context, x, y, vi, onClose }: { text: string; context: string; x: number; y: number; vi: boolean; onClose: () => void }) {
  const [lookup, setLookup] = useState(false);
  if (lookup) return <QuickDictionaryPopover word={text} anchor={{ x, y }} contextSentence={context} onClose={onClose} />;
  return <div className={s.selectionTools} style={{ left: x, top: y }} data-testid="msgr-selection" onMouseDown={e => e.stopPropagation()}>
    <button type="button" onClick={() => setLookup(true)} data-testid="msgr-lookup"><Search size={14} />{vi ? 'Tra từ' : 'Look up'}</button>
    <FlashcardSave text={text} context={context} />
    <button type="button" aria-label={vi ? 'Đóng' : 'Close'} onClick={onClose}><X size={14} /></button>
  </div>;
}

function ShareMenu({ conversationId, direct, vi, onPrompt, onClose }: { conversationId: string; direct: boolean; vi: boolean; onPrompt: (text: string) => void; onClose: () => void }) {
  const share = useMessenger(st => st.share);
  const [tab, setTab] = useState<'prompts' | 'reading' | 'deck'>('prompts');
  const [readings, setReadings] = useState<{ id: number; title: string }[] | null>(null), [decks, setDecks] = useState<{ id: number; title: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (tab === 'reading' && !readings) void getReadingMaterials().then(list => setReadings(list.filter(m => (m as { isSystem?: boolean; system?: boolean }).isSystem ?? (m as { system?: boolean }).system).slice(0, 60).map(m => ({ id: m.id, title: m.title })))).catch(() => setReadings([]));
    if (tab === 'deck' && !decks) void apiClient.get<{ id: number; title: string }[]>('/flashcards/decks/catalog').then(r => setDecks(r.data.slice(0, 60).map(d => ({ id: d.id, title: d.title })))).catch(() => setDecks([]));
  }, [tab, readings, decks]);
  const send = async (kind: 'READING' | 'DECK', id: number) => {
    try { await share(conversationId, kind, id); onClose(); } catch (e) { setError(word(errorCode(e), vi)); }
  };
  return <div className={s.shareMenu} role="dialog" aria-label={vi ? 'Thêm vào tin nhắn' : 'Add to message'} data-testid="msgr-share">
    <div className={s.shareTabs}>
      <button type="button" aria-pressed={tab === 'prompts'} onClick={() => setTab('prompts')}><Lightbulb size={14} />{vi ? 'Gợi ý mở lời' : 'Prompts'}</button>
      {direct && <button type="button" aria-pressed={tab === 'reading'} onClick={() => setTab('reading')} data-testid="msgr-share-reading"><BookOpen size={14} />{vi ? 'Bài đọc' : 'Reading'}</button>}
      {direct && <button type="button" aria-pressed={tab === 'deck'} onClick={() => setTab('deck')} data-testid="msgr-share-deck"><Layers size={14} />{vi ? 'Bộ thẻ' : 'Decks'}</button>}
    </div>
    {error && <p className={s.inviteError} role="alert">{error}</p>}
    <div className={s.shareList}>
      {tab === 'prompts' && arenaPrompts.map(p => <button type="button" key={p.title} onClick={() => { onPrompt(p.title + ': ' + p.hint); onClose(); }}><b>{p.title}</b><span>{p.hint}</span></button>)}
      {tab === 'reading' && (readings === null ? <p className={s.note}>{vi ? 'Đang tải…' : 'Loading…'}</p> : readings.length ? readings.map(r => <button type="button" key={r.id} onClick={() => void send('READING', r.id)}><b>{r.title}</b></button>) : <p className={s.note}>{vi ? 'Chưa có bài đọc chung.' : 'No shared readings.'}</p>)}
      {tab === 'deck' && (decks === null ? <p className={s.note}>{vi ? 'Đang tải…' : 'Loading…'}</p> : decks.length ? decks.map(r => <button type="button" key={r.id} onClick={() => void send('DECK', r.id)}><b>{r.title}</b></button>) : <p className={s.note}>{vi ? 'Chưa có bộ thẻ chung.' : 'No shared decks.'}</p>)}
    </div>
  </div>;
}

/** The message box arriving or leaving tells the floating Echo, which then rests above it (never over Send). */
const announceClear = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('echo:clear-changed')); };

function RequestBar({ conversation, vi }: { conversation: Conversation; vi: boolean }) {
  const answerRequest = useMessenger(st => st.answerRequest), load = useMessenger(st => st.load);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(word(errorCode(e), vi)); } finally { setBusy(false); }
  };
  const other = conversation.other;
  return <div className={s.requestBar} data-testid="msgr-request-bar">
    <p><b>{other?.name}</b> {vi ? 'muốn nhắn tin cho bạn. Người này chưa biết bạn đã đọc.' : 'would like to message you. They will not know you have read this.'}</p>
    {error && <p className={s.inviteError} role="alert">{error}</p>}
    <div>
      <button type="button" className={s.primary} disabled={busy} onClick={() => void act(() => answerRequest(conversation.id, 'accept'))} data-testid="msgr-request-accept"><Check size={15} />{vi ? 'Đồng ý' : 'Accept'}</button>
      <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(() => answerRequest(conversation.id, 'decline'))} data-testid="msgr-request-decline">{vi ? 'Từ chối' : 'Decline'}</button>
      {other && <button type="button" className={s.quiet} disabled={busy} onClick={() => void act(async () => { await messengerApi.block(other.id); await load(); })} data-testid="msgr-request-block"><Ban size={15} />{vi ? 'Chặn' : 'Block'}</button>}
    </div>
  </div>;
}

/** Writing: words, an emoji at the caret, files chosen, dropped or pasted (shown here first, sent only with Send), and the message being answered. */
function Composer({ conversation, vi, reply, onReplyDone, onSent, drop }: { conversation: Conversation; vi: boolean; reply: ChatMessage | null; onReplyDone: () => void; onSent: () => void; drop: File[] | null }) {
  const id = conversation.id, me = useMessenger(st => st.me), send = useMessenger(st => st.send);
  const [text, setText] = useState(''), [files, setFiles] = useState<PendingFile[]>([]), [busy, setBusy] = useState(0), [error, setError] = useState<string | null>(null), [emoji, setEmoji] = useState(false), [share, setShare] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null), picker = useRef<HTMLInputElement | null>(null), lastTyped = useRef(0), kept = useRef<PendingFile[]>([]);
  kept.current = files;
  // Files never sent give their memory back when the composer goes.
  useEffect(() => () => { kept.current.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); }); }, []);
  useEffect(() => { if (reply) input.current?.focus({ preventScroll: true }); }, [reply]);
  const add = useCallback(async (chosen: File[]) => {
    if (!chosen.length) return;
    setError(null); setBusy(n => n + chosen.length);
    for (const file of chosen) {
      try {
        const ready = await prepareFile(file);
        setFiles(list => {
          const next = [...list, ready], over = overLimit(next);
          if (over) { if (ready.url) URL.revokeObjectURL(ready.url); setError(word(over, vi)); return list; }
          return next;
        });
      } catch (e) { setError(word((e as Error).message, vi)); }
      finally { setBusy(n => n - 1); }
    }
    input.current?.focus({ preventScroll: true });
  }, [vi]);
  useEffect(() => { if (drop?.length) void add(drop); }, [drop, add]);
  const remove = (key: string) => setFiles(list => { const f = list.find(x => x.key === key); if (f?.url) URL.revokeObjectURL(f.url); return list.filter(x => x.key !== key); });
  // "@" in a group: the members (read once, when first needed), the name being typed, the people chosen so far.
  const group = conversation.kind === 'GROUP';
  const [members, setMembers] = useState<MessengerPerson[] | null>(null), [chosen, setChosen] = useState<{ id: number; name: string }[]>([]);
  const [pick, setPick] = useState<{ start: number; query: string } | null>(null), [active, setActive] = useState(0);
  const mirror = useRef<HTMLDivElement | null>(null);
  // The mirror takes the field's own box every render (its scrollbar, its height): the highlights sit exactly under the letters.
  useLayoutEffect(() => { const m = mirror.current, el = input.current; if (!m || !el) return; m.style.width = `${el.clientWidth}px`; m.style.height = `${el.clientHeight}px`; m.style.left = `${el.offsetLeft}px`; m.style.top = `${el.offsetTop}px`; m.scrollTop = el.scrollTop; });
  const matches = useMemo(() => pick && members ? mentionMatches(members, pick.query, me) : [], [pick, members, me]);
  const look = (value: string, caret: number) => {
    if (!group) return;
    const q = mentionQuery(value, caret);
    setPick(q); setActive(0);
    if (q && members === null) { setMembers([]); void messengerApi.group(id).then(d => setMembers(d.members.map(m => m.person))).catch(() => setMembers(null)); }
  };
  const choose = (p: MessengerPerson) => {
    const el = input.current, at = pick?.start ?? 0, caret = el?.selectionStart ?? text.length;
    const token = `@${p.name} `, next = (text.slice(0, at) + token + text.slice(caret)).slice(0, 2000);
    setText(next); setChosen(list => list.some(c => c.id === p.id) ? list : [...list, { id: p.id, name: p.name }]); setPick(null);
    requestAnimationFrame(() => { el?.focus(); const end = Math.min(next.length, at + token.length); el?.setSelectionRange(end, end); });
  };
  const spans = useMemo(() => group && chosen.length ? mentionSpans(text, chosen) : [], [group, chosen, text]);
  const submit = () => {
    const body = text.trim();
    if ((!body && !files.length) || busy > 0) return;
    const mentions = group ? mentionSpans(body, chosen) : [];
    setText(''); setFiles([]); setError(null); setEmoji(false); setChosen([]); setPick(null);
    void send(id, body, undefined, { replyTo: reply, files, mentions });
    onReplyDone(); onSent();
    input.current?.focus();
  };
  const onType = (value: string, caret: number) => {
    setText(value);
    if (!value) setChosen([]);
    look(value, caret);
    const now = Date.now();
    if (value && now - lastTyped.current > 2000) { lastTyped.current = now; publishTyping(id); }
  };
  const insert = (e: string) => {
    const el = input.current, start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? text.length;
    const next = (text.slice(0, start) + e + text.slice(end)).slice(0, 2000);
    setText(next);
    requestAnimationFrame(() => { el?.focus(); const at = Math.min(next.length, start + e.length); el?.setSelectionRange(at, at); });
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!conversation.connected) return;
    const pictures = pastedPictures(e.clipboardData);
    if (!pictures.length) return;
    e.preventDefault();
    void add(pictures.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `${vi ? 'anh-dan' : 'pasted'}-${Date.now()}-${i + 1}.${f.type.split('/')[1] || 'png'}`, { type: f.type })));
  };
  const mayAttach = conversation.connected;
  return <form className={s.composer} data-echo-clear="" ref={announceClear} onSubmit={e => { e.preventDefault(); submit(); }}>
    {reply && <div className={s.replyBar} data-testid="msgr-reply-bar">
      <CornerUpLeft size={15} aria-hidden="true" />
      <span><b>{vi ? 'Đang trả lời ' : 'Replying to '}{reply.senderId === me ? (vi ? 'chính bạn' : 'yourself') : reply.senderName ?? ''}</b><em>{reply.body || (reply.attachments?.some(a => a.kind === 'IMAGE') ? (vi ? 'Ảnh' : 'Photo') : (vi ? 'Tệp đính kèm' : 'Attachment'))}</em></span>
      <button type="button" className={s.iconButton} onClick={onReplyDone} aria-label={vi ? 'Thôi trả lời' : 'Cancel reply'} data-testid="msgr-reply-cancel"><X size={16} /></button>
    </div>}
    {(files.length > 0 || busy > 0) && <div className={s.pending} data-testid="msgr-pending" aria-label={vi ? 'Tệp sẽ gửi kèm' : 'Files to send'}>
      {files.map(f => <div key={f.key} className={s.pendingItem} data-kind={f.kind} data-testid="msgr-pending-item">
        {f.kind === 'IMAGE' && f.url ? <img src={f.url} alt={f.name} /> : <span className={s.pendingFile}><FileText size={18} aria-hidden="true" /><b>{f.name}</b><em>{fileSize(f.size)}</em></span>}
        <button type="button" onClick={() => remove(f.key)} aria-label={vi ? `Bỏ ${f.name}` : `Remove ${f.name}`} data-testid="msgr-pending-remove"><X size={13} /></button>
      </div>)}
      {busy > 0 && <div className={s.pendingItem} data-kind="BUSY"><Loader2 size={18} className={s.spin} aria-label={vi ? 'Đang chuẩn bị tệp' : 'Preparing file'} /></div>}
    </div>}
    {error && <p className={s.threadError} role="alert" data-testid="msgr-composer-error">{error}</p>}
    <div className={s.composerLine}>
      {conversation.connected && <div className={s.menuWrap}>
        <button type="button" className={s.iconButton} aria-label={vi ? 'Thêm' : 'Add'} aria-expanded={share} onClick={() => setShare(v => !v)} data-testid="msgr-add"><Plus size={19} /></button>
        {share && <ShareMenu conversationId={id} direct={conversation.kind === 'DIRECT'} vi={vi} onPrompt={p => { setText(p); input.current?.focus(); }} onClose={() => setShare(false)} />}
      </div>}
      {mayAttach && <>
        <button type="button" className={s.iconButton} aria-label={vi ? 'Đính kèm ảnh hoặc tệp' : 'Attach pictures or files'} onClick={() => picker.current?.click()} data-testid="msgr-attach"><Paperclip size={18} /></button>
        <input ref={picker} type="file" hidden multiple accept={ACCEPT} data-testid="msgr-file-input" onChange={e => { const list = Array.from(e.target.files ?? []); e.target.value = ''; void add(list); }} />
      </>}
      <div className={s.inputWrap}>
        {pick && matches.length > 0 && <div className={s.mentionPop} role="listbox" id={`msgr-mention-${id}`} aria-label={vi ? 'Nhắc đến thành viên' : 'Mention a member'} data-testid="msgr-mention-list">
          {matches.map((p, i) => <button type="button" role="option" key={p.id} aria-selected={i === active} data-testid="msgr-mention-option"
            onPointerDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(p)}>
            <Avatar name={p.name} src={p.avatarUrl} size={26} /><b>{p.name}</b>{p.username && <em>@{p.username}</em>}</button>)}
        </div>}
        {/* The chosen "@Name"s, highlighted under the same letters as the field (the field itself stays an ordinary textarea). */}
        {spans.length > 0 && <div ref={mirror} className={s.mentionMirror} aria-hidden="true">
          {mentionSegments(text, spans).map((g, i) => 'id' in g ? <mark key={i}>{g.text}</mark> : <span key={i}>{g.text}</span>)}{'​'}
        </div>}
        <textarea ref={input} rows={1} value={text} maxLength={2000} data-testid="msgr-composer" aria-label={vi ? 'Tin nhắn' : 'Message'} placeholder={vi ? 'Nhập tin nhắn…' : 'Write a message…'}
          role={group ? 'combobox' : undefined} aria-expanded={group ? !!pick && matches.length > 0 : undefined} aria-controls={group && pick && matches.length ? `msgr-mention-${id}` : undefined} aria-autocomplete={group ? 'list' : undefined}
          onChange={e => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)} onPaste={onPaste}
          onScroll={e => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
          onClick={e => look(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)} onBlur={() => setPick(null)}
          onKeyDown={e => {
            if (pick && matches.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); return; }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); choose(matches[Math.min(active, matches.length - 1)]); return; }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPick(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            if (e.key === 'Escape' && reply) { e.stopPropagation(); onReplyDone(); }
          }} />
        <div className={s.menuWrap}>
          <button type="button" className={s.iconButton} aria-label={vi ? 'Chọn biểu tượng cảm xúc' : 'Choose an emoji'} aria-expanded={emoji} onClick={() => setEmoji(v => !v)} data-testid="msgr-emoji"><Smile size={19} /></button>
          {emoji && <div className={s.composerPicker}><EmojiPicker account={me} vi={vi} onPick={insert} onClose={() => setEmoji(false)} /></div>}
        </div>
      </div>
      <button type="submit" className={s.send} disabled={(!text.trim() && !files.length) || busy > 0} aria-label={vi ? 'Gửi' : 'Send'} data-testid="msgr-send"><Send size={17} /></button>
    </div>
  </form>;
}

export default function Thread({ conversation, vi, details, onDetails, onBack, onEnter, onPerson }: { conversation: Conversation; vi: boolean; details: boolean; onDetails: () => void; onBack: () => void; onEnter: (code: string) => void; onPerson: (id: number) => void }) {
  const id = conversation.id, group = conversation.kind === 'GROUP';
  const me = useMessenger(st => st.me), thread = useMessenger(st => st.threads[id]), typing = useMessenger(st => st.typing[id]), skew = useMessenger(st => st.skew);
  const open = useMessenger(st => st.open), older = useMessenger(st => st.older), view = useMessenger(st => st.view), reach = useMessenger(st => st.reach), sendInvite = useMessenger(st => st.invite);
  const [error, setError] = useState<string | null>(null), [inviting, setInviting] = useState(false), [mode, setMode] = useState(false), [finding, setFinding] = useState(false), [found, setFound] = useState<ChatMessage[] | null>(null), [query, setQuery] = useState('');
  const [selection, setSelection] = useState<{ text: string; context: string; x: number; y: number } | null>(null), [reply, setReply] = useState<ChatMessage | null>(null), [fresh, setFresh] = useState(0), [over, setOver] = useState(false), [dropped, setDropped] = useState<File[] | null>(null);
  const list = useRef<HTMLDivElement | null>(null), stuck = useRef(true), anchor = useRef<{ height: number; top: number } | null>(null), seen = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => { void open(id); view(id); stuck.current = true; return () => view(null); }, [id, open, view]);
  useEffect(() => { const onVisible = () => { if (document.visibilityState === 'visible') view(id); }; document.addEventListener('visibilitychange', onVisible); return () => document.removeEventListener('visibilitychange', onVisible); }, [id, view]);
  // "Active 5 minutes ago" moves on without anyone asking the server.
  useEffect(() => { const t = window.setInterval(() => tick(n => n + 1), 60000); return () => clearInterval(t); }, []);
  const messages = thread?.messages, count = messages?.length ?? 0, last = messages?.at(-1), first = messages?.[0]?.ref;
  // Older messages arrive above: what the person was reading stays where it was.
  useLayoutEffect(() => {
    const el = list.current, a = anchor.current;
    if (el && a) { el.scrollTop = a.top + (el.scrollHeight - a.height); anchor.current = null; }
  }, [first]);
  // New messages: follow them when the person is at the end, tell them when they are reading further up.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !last) return;
    if (stuck.current || last.senderId === me) { el.scrollTop = el.scrollHeight; stuck.current = true; setFresh(0); }
    else if (last.id > seen.current && seen.current > 0 && last.kind !== 'SYSTEM') setFresh(n => n + 1);
    if (!last.sending) seen.current = Math.max(seen.current, last.id);
  }, [count, last?.ref, last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const someoneTyping = (typing?.until ?? 0) > Date.now();
  useEffect(() => { if (!someoneTyping) return; const t = window.setTimeout(() => tick(n => n + 1), 3600); return () => clearTimeout(t); }, [someoneTyping, typing]);
  useEffect(() => { if (someoneTyping && stuck.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [someoneTyping]);
  const toEnd = () => { const el = list.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); stuck.current = true; setFresh(0); } };
  const doInvite = async (choice: InviteMode) => {
    setMode(false); setInviting(true); setError(null);
    const code = await sendInvite(id, choice);
    setInviting(false);
    if (code) setError(word(code, vi));
  };
  // Searching asks the server once the typing pauses (300 ms), and only the newest question's answer is shown.
  const searchSeq = useRef(0);
  useEffect(() => {
    const q = query.trim(), seq = ++searchSeq.current;
    if (q.length < 2) { setFound(null); return; }
    const t = window.setTimeout(() => { void messengerApi.messages(id, undefined, q).then(page => { if (seq === searchSeq.current) setFound(page.messages); }, () => { if (seq === searchSeq.current) setFound([]); }); }, 300);
    return () => clearTimeout(t);
  }, [query, id]);
  const search = (q: string) => setQuery(q);
  const onMouseUp = (e: React.MouseEvent) => {
    const sel = window.getSelection(), chosen = sel?.toString().trim() ?? '';
    const bubble = (e.target as HTMLElement).closest?.('[data-bubble]');
    if (!chosen || chosen.length > 60 || !bubble) { if (!(e.target as HTMLElement).closest?.('[data-testid="msgr-selection"]')) setSelection(null); return; }
    const box = sel!.getRangeAt(0).getBoundingClientRect();
    setSelection({ text: chosen, context: bubble.textContent ?? '', x: box.left + box.width / 2, y: box.top });
  };
  /** To the message a reply answers: it is brought into view and marked for a moment. One far back is loaded first, within a bound. */
  const jump = async (messageId: number) => {
    setError(null);
    const find = () => list.current?.querySelector<HTMLElement>(`[data-mid="${messageId}"]`);
    let el = find();
    if (!el) {
      if (found) { setFinding(false); setFound(null); setQuery(''); }
      const before = list.current ? { height: list.current.scrollHeight, top: list.current.scrollTop } : null;
      if (!(await reach(id, messageId))) { setError(word('TOO_FAR', vi)); return; }
      anchor.current = before;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      el = find();
    }
    if (!el) { setError(word('TOO_FAR', vi)); return; }
    stuck.current = false;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.setAttribute('data-flash', '');
    window.setTimeout(() => el?.removeAttribute('data-flash'), 1700);
  };
  const shown = found ?? messages ?? [];
  const lastMine = useMemo(() => [...(messages ?? [])].reverse().find(m => m.senderId === me && !m.sending && !m.failed && m.kind !== 'SYSTEM'), [messages, me]);
  const title = titleOf(conversation), other = conversation.other;
  const now = Date.now() + skew;
  const sub = group ? (vi ? `${conversation.memberCount} thành viên` : `${conversation.memberCount} members`)
    : conversation.request === 'THEIRS' ? (vi ? 'Lời mời trò chuyện' : 'Message request') : !conversation.connected ? (vi ? 'Chưa kết nối' : 'Not connected yet')
    : activityLine(other, vi, now) ?? '';
  const canAct = !conversation.refused && conversation.connected;
  const wordFor = useCallback((code: string | null | undefined) => word(code, vi), [vi]);
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setOver(false); if (canAct && e.dataTransfer.files.length) setDropped(Array.from(e.dataTransfer.files)); };
  return <section className={s.thread} aria-label={title} data-theme={conversation.theme} data-over={over || undefined} data-testid="msgr-thread"
    onDragOver={e => { if (canAct && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={e => { if (e.currentTarget === e.target) setOver(false); }} onDrop={onDrop}>
    <header className={s.threadHead}>
      <button type="button" className={s.back} onClick={onBack} aria-label={vi ? 'Quay lại danh sách' : 'Back to the list'}><ChevronLeft size={22} /></button>
      <button type="button" className={s.whoButton} onClick={() => group || !other ? onDetails() : onPerson(other.id)} aria-label={group ? (vi ? `Thông tin nhóm ${title}` : `About the group ${title}`) : (vi ? `Xem hồ sơ của ${title}` : `See ${title}'s profile`)} data-testid="msgr-open-person">
        <Avatar name={title} src={group ? conversation.avatarUrl : other?.avatarUrl} online={!group && !!other?.online} size={42} group={group} />
        <div className={s.who}><b>{title}{conversation.muted && <BellOff size={13} aria-label={vi ? 'Đã tắt thông báo' : 'Muted'} />}</b><span data-testid="msgr-presence" data-online={(!group && other?.online) || undefined}>{sub}</span></div>
      </button>
      <div className={s.threadTools}>
        {!group && <div className={s.inviteGroup}>
          <button type="button" className={s.inviteButton} disabled={inviting || !canAct} title={conversation.connected ? undefined : word('NOT_CONNECTED', vi)} onClick={() => void doInvite('FREE')} data-testid="msgr-invite-arena">
            {inviting ? <Loader2 size={16} className={s.spin} /> : <Mic size={16} />}<span>{vi ? 'Mời vào Speaking Arena' : 'Invite to Speaking Arena'}</span>
          </button>
          <button type="button" className={s.inviteMore} aria-label={vi ? 'Chọn kiểu phòng' : 'Choose a room type'} aria-expanded={mode} disabled={inviting || !canAct} onClick={() => setMode(v => !v)}><ChevronDown size={15} /></button>
          {mode && <div className={s.menu} role="menu">{MODES.map(m => <button type="button" role="menuitem" key={m.id} onClick={() => void doInvite(m.id)} data-testid={`msgr-invite-mode-${m.id}`}>{vi ? m.vi : m.en}</button>)}</div>}
        </div>}
        <button type="button" className={s.iconButton} aria-label={vi ? 'Tìm trong trò chuyện' : 'Search this conversation'} aria-pressed={finding} onClick={() => { setFinding(v => !v); setFound(null); setQuery(''); }} data-testid="msgr-find"><Search size={18} /></button>
        <button type="button" className={s.iconButton} aria-label={vi ? 'Thông tin cuộc trò chuyện' : 'Conversation details'} aria-pressed={details} aria-expanded={details} onClick={onDetails} data-testid="msgr-details-toggle"><Info size={19} /></button>
      </div>
    </header>
    {finding && <div className={s.findBar}><Search size={15} /><input autoFocus value={query} onChange={e => search(e.target.value)} placeholder={vi ? 'Tìm trong trò chuyện này…' : 'Search this conversation…'} aria-label={vi ? 'Tìm trong trò chuyện' : 'Search this conversation'} /><span>{found ? (vi ? `${found.length} kết quả` : `${found.length} found`) : ''}</span></div>}
    <div className={s.messagesWrap}>
      <div ref={list} className={s.messages} data-testid="msgr-messages" onMouseUp={onMouseUp} onScroll={e => {
        const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        if (stuck.current && fresh) setFresh(0);
        if (el.scrollTop < 60 && !found && thread?.more && !thread.loading) { anchor.current = { height: el.scrollHeight, top: el.scrollTop }; void older(id); }
      }}>
        {thread?.loading && thread.loaded && thread.more && <div className={s.state}><Loader2 className={s.spin} size={16} aria-label={vi ? 'Đang tải tin nhắn cũ hơn' : 'Loading older messages'} /></div>}
        {thread?.error && !count && <div className={s.state} role="alert"><p>{vi ? 'Chưa tải được cuộc trò chuyện.' : 'Could not load this conversation.'}</p><button type="button" className={s.quiet} onClick={() => void open(id)}><RotateCw size={14} />{vi ? 'Thử lại' : 'Try again'}</button></div>}
        {!thread?.loaded && !thread?.error && <div className={s.state}><Loader2 className={s.spin} size={20} aria-label={vi ? 'Đang tải' : 'Loading'} /></div>}
        {thread?.loaded && !count && <div className={s.state} data-testid="msgr-empty"><p>{group ? (vi ? 'Hãy gửi tin nhắn đầu tiên cho nhóm.' : 'Send the first message to the group.') : (vi ? `Hãy gửi lời chào đầu tiên tới ${title}.` : `Say hello to ${title}.`)}</p></div>}
        {shown.map((m, i) => {
          const mine = m.senderId === me, prev = shown[i - 1], head = !prev || !sameDay(prev.at, m.at);
          const joined = !!prev && prev.kind !== 'SYSTEM' && prev.senderId === m.senderId && !head && !m.replyTo && new Date(m.at).getTime() - new Date(prev.at).getTime() < 180000;
          const status = !group && mine && lastMine?.id === m.id && !found ? <span className={s.status} data-testid="msgr-status">
            {conversation.theirRead >= m.id ? <><CheckCheck size={14} />{vi ? 'Đã xem' : 'Seen'}</> : conversation.theirDelivered >= m.id ? <><CheckCheck size={14} />{vi ? 'Đã nhận' : 'Delivered'}</> : <><Check size={14} />{vi ? 'Đã gửi' : 'Sent'}</>}
          </span> : null;
          return <React.Fragment key={m.ref}>
            {head && <p className={s.day}>{dayLabel(m.at, vi)}</p>}
            <MessageRow m={m} mine={mine} me={me} group={group} joined={joined} vi={vi} canAct={canAct && !found} status={status} word={wordFor} onReply={setReply} onJump={mid => void jump(mid)} onEnter={onEnter} onPerson={onPerson} />
          </React.Fragment>;
        })}
        {someoneTyping && <div className={s.typing} data-testid="msgr-typing" aria-live="polite"><span /><span /><span /><em>{vi ? `${(group ? typing?.name : title) ?? title} đang nhập…` : `${(group ? typing?.name : title) ?? title} is typing…`}</em></div>}
      </div>
      {fresh > 0 && <button type="button" className={s.newPill} onClick={toEnd} data-testid="msgr-new-pill"><ArrowDown size={14} />{vi ? `${fresh} tin nhắn mới` : `${fresh} new ${fresh === 1 ? 'message' : 'messages'}`}</button>}
      {over && <div className={s.dropHint} aria-hidden="true"><Paperclip size={22} />{vi ? 'Thả ảnh hoặc tệp vào đây' : 'Drop pictures or files here'}</div>}
    </div>
    {selection && <SelectionTools {...selection} vi={vi} onClose={() => { setSelection(null); window.getSelection()?.removeAllRanges(); }} />}
    {error && <p className={s.threadError} role="alert" data-testid="msgr-thread-error">{error}<button type="button" onClick={() => setError(null)} aria-label={vi ? 'Đóng' : 'Dismiss'}><X size={13} /></button></p>}
    {!group && !conversation.connected && !conversation.refused && conversation.request !== 'THEIRS' && <p className={s.requestNote} data-testid="msgr-request-note">{vi ? `${title} sẽ thấy tin nhắn của bạn trong mục Lời mời. Bạn có thể gửi tối đa 3 tin trước khi được đồng ý.` : `${title} will see this in Requests. You can send up to 3 messages until they accept.`}</p>}
    {conversation.restricted && <p className={s.requestNote} data-testid="msgr-restricted-note">{vi ? `Bạn đang hạn chế ${title}. Họ không thấy khi bạn đọc tin hay đang hoạt động, và tin nhắn của họ không báo cho bạn.` : `You have restricted ${title}. They do not see when you read or when you are active, and their messages do not notify you.`}</p>}
    {conversation.request === 'THEIRS' ? <RequestBar conversation={conversation} vi={vi} /> : conversation.refused
      ? <p className={s.refused} data-testid="msgr-refused">{word(conversation.refused, vi)}</p>
      : <Composer conversation={conversation} vi={vi} reply={reply} onReplyDone={() => setReply(null)} onSent={() => { stuck.current = true; }} drop={dropped} />}
  </section>;
}

export { clock };
