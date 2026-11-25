'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Ban, Bell, BellOff, Camera, Check, ChevronDown, Crown, Download, EyeOff, FileText, Loader2, LogOut, Pencil, Pin, PinOff, Search, Shield, Trash2, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { attachmentUrl, messengerApi } from '@/services/messengerApi';
import { errorCode, titleOf, useMessenger } from '@/lib/messenger/store';
import { THEMES, activityLine, fileSize } from '@/lib/messenger/chatKit';
import type { Attachment, Conversation, GroupDetail, GroupRole, MuteFor, ThemeId } from '@/types/messenger';
import { Avatar, Lightbox } from './MessageParts';
import { word } from './Thread';
import s from './messenger.module.css';

const MUTES: { id: MuteFor; vi: string; en: string }[] = [
  { id: 'H1', vi: 'Trong 1 giờ', en: 'For 1 hour' }, { id: 'H8', vi: 'Trong 8 giờ', en: 'For 8 hours' }, { id: 'D1', vi: 'Trong 24 giờ', en: 'For 24 hours' }, { id: 'FOREVER', vi: 'Cho đến khi tôi bật lại', en: 'Until I turn it back on' },
];
export const mutedLine = (c: Conversation, vi: boolean) => {
  if (!c.muted) return null;
  const until = c.mutedUntil ? new Date(c.mutedUntil) : null;
  if (!until || until.getFullYear() > 9000) return vi ? 'Đã tắt thông báo' : 'Notifications off';
  const at = new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(until);
  return vi ? `Tắt thông báo đến ${at}` : `Notifications off until ${at}`;
};

/** A dialog that keeps the keyboard inside it, closes on Escape and gives the focus back. */
function useDialog(onClose: () => void) {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !root.current) return;
      const items = Array.from(root.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, [href], [tabindex="0"]'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); was?.focus?.({ preventScroll: true }); };
  }, [onClose]);
  return root;
}

/** Choosing friends: for a new group (with its name), or to bring into an existing one. Only friends are listed, because only friends may be added. */
export function GroupDialog({ vi, group, present, onClose, onDone }: { vi: boolean; group?: Conversation | null; present?: number[]; onClose: () => void; onDone: (conversation: Conversation | null) => void }) {
  const friends = useMessenger(st => st.people.friends), more = useMessenger(st => st.people.moreFriends), moreFriends = useMessenger(st => st.moreFriends), adopt = useMessenger(st => st.adopt);
  const [title, setTitle] = useState(''), [query, setQuery] = useState(''), [chosen, setChosen] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const root = useDialog(onClose);
  const q = query.trim().toLowerCase();
  const list = useMemo(() => friends.filter(f => !present?.includes(f.id) && (!q || f.name.toLowerCase().includes(q) || f.username?.includes(q))), [friends, present, q]);
  const room = 50 - (present?.length ?? 1);
  const toggle = (id: number) => setChosen(c => c.includes(id) ? c.filter(x => x !== id) : c.length >= room ? c : [...c, id]);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (group) { await messengerApi.addMembers(group.id, chosen); onDone(null); }
      else { const made = await messengerApi.createGroup(title.trim(), chosen); adopt(made); onDone(made); }
    } catch (e) { setError(word(errorCode(e), vi)); setBusy(false); }
  };
  const ready = chosen.length > 0 && (!!group || title.trim().length > 0);
  return <div className={s.dialogBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={root} className={s.dialog} role="dialog" aria-modal="true" aria-label={group ? (vi ? 'Thêm thành viên' : 'Add members') : (vi ? 'Tạo nhóm trò chuyện' : 'Create a group')} data-testid="msgr-group-dialog">
      <header><h3>{group ? (vi ? 'Thêm thành viên' : 'Add members') : (vi ? 'Tạo nhóm trò chuyện' : 'Create a group')}</h3><button type="button" className={s.iconButton} onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'}><X size={17} /></button></header>
      {!group && <label className={s.field}><span>{vi ? 'Tên nhóm' : 'Group name'}</span><input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder={vi ? 'Ví dụ: Luyện IELTS Speaking' : 'For example: IELTS Speaking practice'} data-testid="msgr-group-title" /></label>}
      <label className={s.search}><Search size={15} aria-hidden="true" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm trong bạn bè…' : 'Search your friends…'} aria-label={vi ? 'Tìm trong bạn bè' : 'Search your friends'} /></label>
      <p className={s.note}>{vi ? `Đã chọn ${chosen.length}. Chỉ thêm được bạn bè của bạn; nhóm có tối đa 50 thành viên.` : `${chosen.length} chosen. Only your friends can be added; a group has up to 50 members.`}</p>
      <ul className={s.pickList}>
        {list.map(f => <li key={f.id}><label data-chosen={chosen.includes(f.id) || undefined}>
          <input type="checkbox" checked={chosen.includes(f.id)} onChange={() => toggle(f.id)} data-testid={`msgr-pick-${f.id}`} />
          <Avatar name={f.name} src={f.avatarUrl} size={34} /><span><b>{f.name}</b>{f.username && <em>@{f.username}</em>}</span>
        </label></li>)}
        {!list.length && <li className={s.note}>{friends.length ? (vi ? 'Không có bạn nào phù hợp.' : 'No friend matches.') : (vi ? 'Bạn chưa có bạn bè để thêm vào nhóm.' : 'You have no friends to add yet.')}</li>}
        {more && !q && <li><button type="button" className={s.moreButton} onClick={() => void moreFriends()}>{vi ? 'Xem thêm' : 'Show more'}</button></li>}
      </ul>
      {error && <p className={s.inviteError} role="alert">{error}</p>}
      <footer><button type="button" className={s.quiet} onClick={onClose}>{vi ? 'Huỷ' : 'Cancel'}</button>
        <button type="button" className={s.primary} disabled={!ready || busy} onClick={() => void submit()} data-testid="msgr-group-submit">{busy ? <Loader2 size={15} className={s.spin} /> : group ? <UserPlus size={15} /> : <Users size={15} />}{group ? (vi ? 'Thêm vào nhóm' : 'Add to group') : (vi ? 'Tạo nhóm' : 'Create group')}</button></footer>
    </div>
  </div>;
}

/** A square picture of at most 256 px, made on this device: a group's picture never needs more. */
async function squarePicture(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const side = Math.min(bitmap.width, bitmap.height), canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(256, side);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  } catch { return null; }
}

/** A yes / no question: the keyboard stays inside, Escape is "no", the focus goes back where it was. */
function ConfirmBox({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const root = useDialog(onClose);
  return <div className={s.dialogBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={root} className={s.dialog} role="alertdialog" aria-modal="true" aria-label={label} data-testid="msgr-confirm">{children}</div>
  </div>;
}

function Section({ title, children, open = true, testid }: { title: string; children: React.ReactNode; open?: boolean; testid?: string }) {
  const [shown, setShown] = useState(open);
  return <section className={s.detailSection} data-testid={testid}>
    <button type="button" className={s.detailToggle} aria-expanded={shown} onClick={() => setShown(v => !v)}><span>{title}</span><ChevronDown size={16} aria-hidden="true" /></button>
    {shown && <div className={s.detailBody}>{children}</div>}
  </section>;
}

function Shared({ id, vi }: { id: string; vi: boolean }) {
  const [kind, setKind] = useState<'IMAGE' | 'FILE'>('IMAGE'), [items, setItems] = useState<Attachment[] | null>(null), [light, setLight] = useState<number | null>(null);
  const rev = useMessenger(st => st.threads[id]?.messages.length ?? 0);
  useEffect(() => { let live = true; setItems(null); void messengerApi.shared(id, kind).then(list => { if (live) setItems(list); }).catch(() => { if (live) setItems([]); }); return () => { live = false; }; }, [id, kind, rev]);
  return <>
    <div className={s.segment} role="tablist"><button type="button" role="tab" aria-selected={kind === 'IMAGE'} onClick={() => setKind('IMAGE')} data-testid="msgr-shared-images">{vi ? 'Ảnh' : 'Photos'}</button><button type="button" role="tab" aria-selected={kind === 'FILE'} onClick={() => setKind('FILE')} data-testid="msgr-shared-files">{vi ? 'Tệp' : 'Files'}</button></div>
    {items === null ? <div className={s.state}><Loader2 size={18} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div>
      : !items.length ? <p className={s.note}>{kind === 'IMAGE' ? (vi ? 'Chưa có ảnh nào được gửi.' : 'No photos shared yet.') : (vi ? 'Chưa có tệp nào được gửi.' : 'No files shared yet.')}</p>
      : kind === 'IMAGE' ? <div className={s.sharedGrid}>{items.map((a, i) => <button type="button" key={a.id} onClick={() => setLight(i)} aria-label={vi ? `Xem ảnh ${a.name}` : `View ${a.name}`}><img src={attachmentUrl(a.id, a.thumb)} alt="" loading="lazy" /></button>)}</div>
      : <div className={s.sharedFiles}>{items.map(a => <a key={a.id} className={s.fileCard} href={attachmentUrl(a.id)} download={a.name}><span className={s.fileIcon} aria-hidden="true"><FileText size={17} /></span><span className={s.fileText}><b>{a.name}</b><em>{fileSize(a.size)}</em></span><Download size={15} aria-hidden="true" /></a>)}</div>}
    {light !== null && items && <Lightbox items={items} index={light} vi={vi} onClose={() => setLight(null)} />}
  </>;
}

/**
 * Everything about one conversation that is not its messages: who it is with, how it looks (the theme is shared by everyone in it), what I chose for it (mute, pin,
 * archive), what was shared in it, and the choices about the person (restrict, block, unfriend) or the group (its people, leaving).
 */
export default function ConversationDetails({ conversation, vi, onClose, onPerson, onGone }: { conversation: Conversation; vi: boolean; onClose: () => void; onPerson: (id: number) => void; onGone: () => void }) {
  const id = conversation.id, group = conversation.kind === 'GROUP', other = conversation.other;
  const me = useMessenger(st => st.me), configure = useMessenger(st => st.configure), load = useMessenger(st => st.load), skew = useMessenger(st => st.skew), rev = useMessenger(st => st.rev[id] ?? 0);
  const [detail, setDetail] = useState<GroupDetail | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [muteMenu, setMuteMenu] = useState(false), [adding, setAdding] = useState(false), [renaming, setRenaming] = useState<string | null>(null), [confirm, setConfirm] = useState<null | 'block' | 'leave' | 'hide'>(null), [memberMenu, setMemberMenu] = useState<number | null>(null);
  const picture = useRef<HTMLInputElement | null>(null);
  const reload = useCallback(() => { if (group) void messengerApi.group(id).then(setDetail).catch(() => setDetail(null)); }, [group, id]);
  useEffect(() => { reload(); }, [reload, rev]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(word(errorCode(e), vi)); } finally { setBusy(false); }
  };
  const title = titleOf(conversation), role = detail?.conversation.role ?? conversation.role, manages = role === 'OWNER' || role === 'ADMIN';
  const sub = group ? (vi ? `${detail?.members.length ?? conversation.memberCount} thành viên` : `${detail?.members.length ?? conversation.memberCount} members`) : activityLine(other, vi, Date.now() + skew) ?? (other?.username ? '@' + other.username : '');
  const mayTheme = !conversation.refused && conversation.connected;
  const roleName = (r: GroupRole) => r === 'OWNER' ? (vi ? 'Trưởng nhóm' : 'Owner') : r === 'ADMIN' ? (vi ? 'Phó nhóm' : 'Admin') : (vi ? 'Thành viên' : 'Member');
  return <aside className={s.details} aria-label={vi ? 'Thông tin cuộc trò chuyện' : 'Conversation details'} data-testid="msgr-details">
    <header className={s.detailsHead}><h3>{vi ? 'Thông tin' : 'Details'}</h3><button type="button" className={s.iconButton} onClick={onClose} aria-label={vi ? 'Đóng thông tin' : 'Close details'} data-testid="msgr-details-close"><X size={17} /></button></header>
    <div className={s.detailsScroll}>
      <div className={s.detailsWho}>
        <span className={s.detailsAvatar}>
          <Avatar name={title} src={group ? (detail?.conversation.avatarUrl ?? conversation.avatarUrl) : other?.avatarUrl} online={!group && !!other?.online} size={84} group={group} />
          {group && manages && <><button type="button" onClick={() => picture.current?.click()} aria-label={vi ? 'Đổi ảnh nhóm' : 'Change the group picture'} data-testid="msgr-group-avatar"><Camera size={15} /></button>
            <input ref={picture} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(async () => { const blob = await squarePicture(f); if (!blob) throw { response: { data: { code: 'ATTACHMENT_NOT_ALLOWED' } } }; await messengerApi.groupAvatar(id, blob); await load(); }); }} /></>}
        </span>
        {renaming !== null ? <form className={s.renameForm} onSubmit={e => { e.preventDefault(); const t = renaming.trim(); if (t) void act(async () => { await messengerApi.renameGroup(id, t); setRenaming(null); await load(); }); }}>
          <input autoFocus value={renaming} maxLength={60} onChange={e => setRenaming(e.target.value)} aria-label={vi ? 'Tên nhóm' : 'Group name'} data-testid="msgr-rename-input" />
          <button type="submit" className={s.small} disabled={busy || !renaming.trim()} data-testid="msgr-rename-save"><Check size={14} />{vi ? 'Lưu' : 'Save'}</button>
          <button type="button" className={s.smallQuiet} onClick={() => setRenaming(null)}>{vi ? 'Huỷ' : 'Cancel'}</button>
        </form> : <b>{title}{group && manages && <button type="button" className={s.inlineIcon} onClick={() => setRenaming(title)} aria-label={vi ? 'Đổi tên nhóm' : 'Rename the group'} data-testid="msgr-rename"><Pencil size={14} /></button>}</b>}
        {sub && <span data-online={(!group && other?.online) || undefined}>{sub}</span>}
        {!group && other && <button type="button" className={s.smallQuiet} onClick={() => onPerson(other.id)}>{vi ? 'Xem hồ sơ' : 'View profile'}</button>}
      </div>
      {error && <p className={s.inviteError} role="alert" data-testid="msgr-details-error">{error}</p>}
      <div className={s.quickRow}>
        <div className={s.menuWrap}>
          <button type="button" aria-pressed={conversation.muted} aria-expanded={muteMenu} disabled={busy} onClick={() => conversation.muted ? void act(() => configure(id, { mute: 'OFF' })) : setMuteMenu(v => !v)} data-testid="msgr-mute">{conversation.muted ? <BellOff size={18} /> : <Bell size={18} />}<span>{conversation.muted ? (vi ? 'Bật thông báo' : 'Unmute') : (vi ? 'Tắt thông báo' : 'Mute')}</span></button>
          {muteMenu && <div className={s.menu} role="menu" data-side="left">{MUTES.map(m => <button type="button" role="menuitem" key={m.id} onClick={() => { setMuteMenu(false); void act(() => configure(id, { mute: m.id })); }} data-testid={`msgr-mute-${m.id}`}>{vi ? m.vi : m.en}</button>)}</div>}
        </div>
        <button type="button" aria-pressed={conversation.pinned} disabled={busy} onClick={() => void act(() => configure(id, { pinned: !conversation.pinned }))} data-testid="msgr-pin">{conversation.pinned ? <PinOff size={18} /> : <Pin size={18} />}<span>{conversation.pinned ? (vi ? 'Bỏ ghim' : 'Unpin') : (vi ? 'Ghim' : 'Pin')}</span></button>
        <button type="button" aria-pressed={conversation.archived} disabled={busy} onClick={() => void act(async () => { await configure(id, { archived: !conversation.archived }); })} data-testid="msgr-archive">{conversation.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}<span>{conversation.archived ? (vi ? 'Bỏ lưu trữ' : 'Unarchive') : (vi ? 'Lưu trữ' : 'Archive')}</span></button>
      </div>
      {conversation.muted && <p className={s.note} data-testid="msgr-muted-line">{mutedLine(conversation, vi)}</p>}

      <Section title={vi ? 'Chủ đề cuộc trò chuyện' : 'Conversation theme'} testid="msgr-themes">
        <div className={s.themeGrid} role="radiogroup" aria-label={vi ? 'Chủ đề' : 'Theme'}>
          {THEMES.map(t => <button type="button" role="radio" key={t.id} aria-checked={conversation.theme === t.id} disabled={busy || !mayTheme} onClick={() => void act(() => configure(id, { theme: t.id as ThemeId }))} data-testid={`msgr-theme-${t.id}`}>
            <i style={{ background: t.swatch }} aria-hidden="true">{conversation.theme === t.id && <Check size={14} />}</i><span>{vi ? t.vi : t.en}</span></button>)}
        </div>
        <p className={s.note}>{vi ? 'Chủ đề là của cả cuộc trò chuyện: mọi người trong đó đều thấy khi bạn đổi.' : 'The theme belongs to the conversation: everyone in it sees the change.'}</p>
      </Section>

      {group && <Section title={vi ? `Thành viên (${detail?.members.length ?? conversation.memberCount})` : `Members (${detail?.members.length ?? conversation.memberCount})`} testid="msgr-members">
        <button type="button" className={s.rowButton} onClick={() => setAdding(true)} data-testid="msgr-add-members"><UserPlus size={17} />{vi ? 'Thêm thành viên' : 'Add members'}</button>
        {!detail ? <div className={s.state}><Loader2 size={18} className={s.spin} aria-label={vi ? 'Đang tải' : 'Loading'} /></div> : <ul className={s.memberList}>
          {detail.members.map(m => {
            const self = m.person.id === me, canManage = !self && m.role !== 'OWNER' && (role === 'OWNER' || (role === 'ADMIN' && m.role === 'MEMBER'));
            return <li key={m.person.id} data-testid={`msgr-member-${m.person.id}`}>
              <button type="button" className={s.personOpen} onClick={() => onPerson(m.person.id)}><Avatar name={m.person.name} src={m.person.avatarUrl} online={m.person.online} size={36} />
                <span className={s.personText}><b>{m.person.name}{self ? (vi ? ' (bạn)' : ' (you)') : ''}</b><em>{m.role === 'OWNER' ? <Crown size={11} aria-hidden="true" /> : m.role === 'ADMIN' ? <Shield size={11} aria-hidden="true" /> : null}{roleName(m.role)}</em></span></button>
              {canManage && <div className={s.menuWrap}>
                <button type="button" className={s.iconButton} aria-label={vi ? `Tuỳ chọn cho ${m.person.name}` : `Options for ${m.person.name}`} aria-expanded={memberMenu === m.person.id} onClick={() => setMemberMenu(memberMenu === m.person.id ? null : m.person.id)} data-testid={`msgr-member-menu-${m.person.id}`}><ChevronDown size={16} /></button>
                {memberMenu === m.person.id && <div className={s.menu} role="menu">
                  {role === 'OWNER' && <button type="button" role="menuitem" onClick={() => { setMemberMenu(null); void act(async () => setDetail(await messengerApi.setRole(id, m.person.id, m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'))); }} data-testid="msgr-member-admin"><Shield size={15} />{m.role === 'ADMIN' ? (vi ? 'Bỏ quyền phó nhóm' : 'Remove as admin') : (vi ? 'Đặt làm phó nhóm' : 'Make admin')}</button>}
                  {role === 'OWNER' && <button type="button" role="menuitem" onClick={() => { setMemberMenu(null); void act(async () => { setDetail(await messengerApi.setRole(id, m.person.id, 'OWNER')); await load(); }); }} data-testid="msgr-member-owner"><Crown size={15} />{vi ? 'Chuyển quyền trưởng nhóm' : 'Make owner'}</button>}
                  <button type="button" role="menuitem" data-danger="" onClick={() => { setMemberMenu(null); void act(async () => setDetail(await messengerApi.removeMember(id, m.person.id))); }} data-testid="msgr-member-remove"><UserMinus size={15} />{vi ? 'Mời ra khỏi nhóm' : 'Remove from group'}</button>
                </div>}
              </div>}
            </li>;
          })}
        </ul>}
      </Section>}

      <Section title={vi ? 'Ảnh và tệp đã gửi' : 'Shared photos and files'} open={false} testid="msgr-shared-section"><Shared id={id} vi={vi} /></Section>

      <Section title={vi ? 'Quyền riêng tư và hỗ trợ' : 'Privacy and support'} testid="msgr-privacy">
        {!group && other && <>
          <button type="button" className={s.rowButton} disabled={busy} onClick={() => void act(async () => { await (conversation.restricted ? messengerApi.unrestrict(other.id) : messengerApi.restrict(other.id)); await load(); if (!conversation.restricted) onGone(); })} data-testid="msgr-restrict"><EyeOff size={17} />
            <span><b>{conversation.restricted ? (vi ? 'Bỏ hạn chế' : 'Unrestrict') : (vi ? 'Hạn chế' : 'Restrict')}</b><em>{vi ? 'Nhẹ hơn chặn: tin nhắn của họ nằm ở mục Hạn chế và không báo cho bạn; họ không thấy khi bạn đọc tin hay đang hoạt động. Họ không được báo.' : 'Milder than blocking: their messages wait in Restricted without notifying you; they do not see when you read or when you are active. They are not told.'}</em></span></button>
          {conversation.refused === 'BLOCKED_BY_ME'
            ? <button type="button" className={s.rowButton} disabled={busy} onClick={() => void act(async () => { await messengerApi.unblock(other.id); await load(); })} data-testid="msgr-unblock"><Ban size={17} /><span><b>{vi ? 'Bỏ chặn' : 'Unblock'}</b></span></button>
            : <button type="button" className={s.rowButton} data-danger="" disabled={busy} onClick={() => setConfirm('block')} data-testid="msgr-block"><Ban size={17} /><span><b>{vi ? 'Chặn' : 'Block'}</b><em>{vi ? 'Hai bạn không nhắn tin, gửi tệp hay mời nhau được nữa. Họ không được báo.' : 'Neither of you can write, send files or invite the other. They are not told.'}</em></span></button>}
          {other.relation === 'FRIEND' && <button type="button" className={s.rowButton} disabled={busy} onClick={() => void act(async () => { await messengerApi.removeFriend(other.id); await load(); })} data-testid="msgr-unfriend"><UserMinus size={17} /><span><b>{vi ? 'Huỷ kết bạn' : 'Unfriend'}</b></span></button>}
        </>}
        {group && <button type="button" className={s.rowButton} data-danger="" disabled={busy} onClick={() => setConfirm('leave')} data-testid="msgr-leave"><LogOut size={17} /><span><b>{vi ? 'Rời nhóm' : 'Leave group'}</b><em>{role === 'OWNER' ? (vi ? 'Quyền trưởng nhóm sẽ chuyển cho phó nhóm hoặc thành viên lâu nhất.' : 'Ownership passes to an admin, or to the longest-standing member.') : (vi ? 'Bạn sẽ không còn đọc được nhóm này.' : 'You will no longer be able to read this group.')}</em></span></button>}
        <button type="button" className={s.rowButton} disabled={busy} onClick={() => setConfirm('hide')} data-testid="msgr-hide"><Trash2 size={17} /><span><b>{vi ? 'Xoá khỏi danh sách của tôi' : 'Remove from my list'}</b><em>{vi ? 'Chỉ xoá ở phía bạn. Tin nhắn mới sẽ đưa cuộc trò chuyện trở lại.' : 'Only on your side. A new message brings the conversation back.'}</em></span></button>
      </Section>
    </div>
    {confirm && <ConfirmBox onClose={() => setConfirm(null)} label={vi ? 'Xác nhận' : 'Confirm'}>
        <h3>{confirm === 'block' ? (vi ? `Chặn ${title}?` : `Block ${title}?`) : confirm === 'leave' ? (vi ? `Rời nhóm ${title}?` : `Leave ${title}?`) : (vi ? 'Xoá cuộc trò chuyện khỏi danh sách của bạn?' : 'Remove this conversation from your list?')}</h3>
        <p className={s.note}>{confirm === 'block' ? (vi ? 'Bạn có thể bỏ chặn bất cứ lúc nào trong mục Lời mời.' : 'You can unblock at any time in Requests.') : confirm === 'leave' ? (vi ? 'Muốn trở lại, một thành viên là bạn bè của bạn cần thêm bạn vào.' : 'To come back, a member who is your friend has to add you.') : (vi ? 'Những tin nhắn hiện có sẽ không còn hiển thị với bạn.' : 'The messages there now will no longer be shown to you.')}</p>
        <footer><button type="button" className={s.quiet} onClick={() => setConfirm(null)} autoFocus>{vi ? 'Huỷ' : 'Cancel'}</button>
          <button type="button" className={s.primary} data-danger="" disabled={busy} data-testid="msgr-confirm-yes" onClick={() => { const what = confirm; setConfirm(null); void act(async () => {
            if (what === 'block' && other) { await messengerApi.block(other.id); await load(); }
            if (what === 'leave') { await messengerApi.leaveGroup(id); await load(); onGone(); }
            if (what === 'hide') { await configure(id, { hidden: true }); onGone(); }
          }); }}>{confirm === 'block' ? (vi ? 'Chặn' : 'Block') : confirm === 'leave' ? (vi ? 'Rời nhóm' : 'Leave') : (vi ? 'Xoá' : 'Remove')}</button></footer>
    </ConfirmBox>}
    {adding && <GroupDialog vi={vi} group={conversation} present={detail?.members.map(m => m.person.id)} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); void load(); }} />}
  </aside>;
}
