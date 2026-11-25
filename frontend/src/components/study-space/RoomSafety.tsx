'use client';

import React, { useRef, useState } from 'react';
import { Eraser, RotateCcw, Save, Undo2, X } from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';
import s from './studySpace.module.css';

/** Confirmation dialog for Reset Room: restores default room objects, rotations, tools, and clears stuck interaction states. */
export function ResetRoomDialog({
  vi = false,
  onCancel,
  onConfirm,
}: {
  vi?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useDialogFocus(ref, () => {
    if (!busy) onCancel();
  });
  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={s.panelWrap}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={ref}
        className={`${s.clearDialog} ${s.glass}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reset-room-title"
        aria-describedby="reset-room-body"
        data-testid="reset-room-dialog"
      >
        <h2 id="reset-room-title" className={s.clearTitle}>
          <RotateCcw size={20} aria-hidden="true" />{' '}
          {vi ? 'Đặt lại căn phòng về mặc định?' : 'Reset Room to Default State?'}
        </h2>
        <div id="reset-room-body" className={s.clearBody}>
          <p>
            {vi
              ? 'Khôi phục vị trí, góc xoay chuẩn và trạng thái ban đầu cho toàn bộ đồ vật, chổi và dụng cụ dọn dẹp, sách, ly, chậu cây cùng nội thất trong phòng.'
              : 'Restores default positions, upright rotations, and clean states for all movable furniture, plant pots, cups, books, and cleaning tools on their rack.'}
          </p>
          <p>
            {vi
              ? 'Xóa các trạng thái cầm nắm hoặc tương tác đang bị kẹt và đưa nhân vật ra vị trí đứng an toàn.'
              : 'Clears any stuck holding or interaction states and places your character safely on open floor.'}
          </p>
          <p>
            {vi
              ? 'Giữ nguyên toàn bộ tiến trình học tập, tài khoản, Campus Credits, kỹ năng, ghi chú và các khu vực khác.'
              : 'Preserves all your progression, Campus Credits, skills, account, learning data, notes, and other rooms.'}
          </p>
        </div>
        <div className={s.clearActions}>
          <button
            type="button"
            className={s.btn}
            onClick={onCancel}
            disabled={busy}
            data-testid="reset-room-cancel"
          >
            {vi ? 'Hủy' : 'Cancel'}
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={`${s.btn} ${s.primary}`}
            onClick={() => void handleConfirm()}
            disabled={busy}
            data-testid="reset-room-confirm"
          >
            <RotateCcw size={15} />{' '}
            {busy ? (vi ? 'Đang đặt lại…' : 'Resetting…') : vi ? 'Đặt lại phòng' : 'Reset Room'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Before anything leaves the screen: says what goes, what stays, and offers to keep the room first. */
export function ClearDialog({ suggestedName, onCancel, onClear }: { suggestedName: string; onCancel: () => void; onClear: (saveAs: string | null) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  useDialogFocus(ref, () => { if (!busy) onCancel(); });
  const run = async (mode: 'save' | 'clear') => {
    setBusy(mode);
    try { await onClear(mode === 'save' ? name.trim().slice(0, 40) || suggestedName : null); } finally { setBusy(null); }
  };
  return (
    <div className={s.panelWrap} onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div ref={ref} className={`${s.clearDialog} ${s.glass}`} role="alertdialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-body" data-testid="clear-dialog">
        <h2 id="clear-title" className={s.clearTitle}><Eraser size={20} aria-hidden="true" /> Xóa trắng căn phòng?</h2>
        <div id="clear-body" className={s.clearBody}>
          <p>Phòng, nội thất, nhân vật và các công cụ đang mở sẽ rời khỏi màn hình.</p>
          <p>Vẫn giữ nguyên: hình nền và Giao diện, mặc định của bạn, ghi chú, việc cần làm, phiên tập trung và tài liệu.</p>
          <p>Bạn luôn có thể khôi phục lại căn phòng này ngay sau khi xóa, kể cả khi tải lại trang.</p>
        </div>
        <label className={s.field}>Tên để lưu phòng này
          <input className={s.input} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="clear-name" />
        </label>
        <div className={s.clearActions}>
          <button type="button" className={s.btn} onClick={onCancel} disabled={!!busy} data-testid="clear-cancel">Hủy</button>
          <span style={{ flex: 1 }} />
          <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void run('clear')} disabled={!!busy} data-testid="clear-confirm"><Eraser size={15} /> {busy === 'clear' ? 'Đang xóa…' : 'Chỉ xóa trắng'}</button>
          <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void run('save')} disabled={!!busy} data-testid="clear-save"><Save size={15} /> {busy === 'save' ? 'Đang lưu…' : 'Lưu phòng rồi xóa'}</button>
        </div>
      </div>
    </div>
  );
}

/** The way back: right after a clear, and again after a reload while the room is still empty. Leaves by itself, so the clear view stays clear. */
export function UndoClearBar({ busy, onUndo, onDismiss }: { busy: boolean; onUndo: () => void; onDismiss: () => void }) {
  return (
    <div className={`${s.toast} ${s.glass} ${s.undoBar}`} role="status" data-testid="clear-undo-bar">
      Đã xóa trắng căn phòng.
      <button type="button" className={`${s.btn} ${s.primary}`} onClick={onUndo} disabled={busy} data-testid="clear-undo"><Undo2 size={14} /> {busy ? 'Đang khôi phục…' : 'Hoàn tác'}</button>
      <button type="button" className={s.iconBtn} onClick={onDismiss} aria-label="Ẩn thông báo"><X size={14} /></button>
    </div>
  );
}
