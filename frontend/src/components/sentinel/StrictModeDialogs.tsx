'use client';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { ShieldAlert, ShieldX } from 'lucide-react';
import styles from './sentinel.module.css';

/** A small modal used by the three Sentinel moments; focus stays inside, Escape = the safe answer. */
function Modal({ tone, icon, title, children, actions, onEscape }: {
  tone: 'warn' | 'void'; icon: ReactNode; title: string; children: ReactNode; actions: ReactNode; onEscape?: () => void;
}) {
  const id = useId(), box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = box.current; if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    (node.querySelector('[data-primary]') as HTMLElement | null)?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) { event.preventDefault(); onEscape(); return; }
      if (event.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => { node.removeEventListener('keydown', onKey); previous?.focus?.({ preventScroll: true }); };
  }, [onEscape]);
  return <div className={styles.scrim}>
    <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className={styles.panel} data-tone={tone}>
      <div className={styles.head}><span className={styles.icon} aria-hidden="true">{icon}</span><h2 id={`${id}-t`} className={styles.title}>{title}</h2></div>
      <div id={`${id}-d`} className={styles.body}>{children}</div>
      <div className={styles.actions}>{actions}</div>
    </div>
  </div>;
}

/** Shown before every ranked attempt; the server opens the attempt only after "Tôi đã hiểu — Bắt đầu". */
export function StrictModeGate({ vi, busy, error, onAccept, onBack, graceSeconds }: {
  vi: boolean; busy: boolean; error?: string | null; onAccept: () => void; onBack: () => void; graceSeconds: number;
}) {
  return <Modal tone="warn" icon={<ShieldAlert />} title={vi ? 'CHẾ ĐỘ THI NGHIÊM NGẶT' : 'STRICT CONTEST MODE'} onEscape={busy ? undefined : onBack}
    actions={<>
      <button type="button" className={styles.ghost} onClick={onBack} disabled={busy}>{vi ? 'Quay lại' : 'Go back'}</button>
      <button type="button" data-primary className={styles.primary} onClick={onAccept} disabled={busy}>{busy ? (vi ? 'Đang chuẩn bị…' : 'Preparing…') : (vi ? 'Tôi đã hiểu — Bắt đầu' : 'I understand — Start')}</button>
    </>}>
    {vi ? <>
      <p>Trong suốt quá trình làm bài hoặc thi đấu, bạn phải ở lại màn hình hiện tại.</p>
      <p>Nếu chuyển tab, chuyển sang ứng dụng khác, thu nhỏ trình duyệt, tải lại trang hoặc thoát khỏi phiên thi, lượt hiện tại sẽ bị hủy và không được tính điểm.</p>
      <p>Để nhận điểm và được xếp hạng, bạn phải bắt đầu một lượt mới từ đầu.</p>
      <p>Hãy chuẩn bị mọi thứ cần thiết trước khi bắt đầu.</p>
      <p className={styles.fine}>Nếu kết nối bị gián đoạn quá {graceSeconds} giây, hệ thống không thể xác nhận lượt thi liên tục và lượt đó cũng không được tính điểm (không bị xem là gian lận). Lượt bị hủy chỉ mất điểm của lượt đó, không ảnh hưởng tài khoản hay kết quả học tập khác.</p>
    </> : <>
      <p>For the whole contest you must stay on this screen.</p>
      <p>If you switch tabs, switch to another app, minimise the browser, reload the page or leave the session, this attempt is cancelled and does not score.</p>
      <p>To score and be ranked you must start a new attempt from the beginning.</p>
      <p>Prepare everything you need before you start.</p>
      <p className={styles.fine}>If the connection is interrupted for more than {graceSeconds} seconds the attempt cannot be confirmed as continuous and does not score either (it is not treated as cheating). A cancelled attempt only loses that attempt&apos;s points; your account and other learning are not affected.</p>
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </Modal>;
}

/** An in-app exit during a ranked attempt asks first; staying changes nothing. */
export function StrictExitConfirm({ vi, onStay, onLeave }: { vi: boolean; onStay: () => void; onLeave: () => void }) {
  return <Modal tone="warn" icon={<ShieldAlert />} title={vi ? 'Rời khỏi phiên thi?' : 'Leave the contest?'} onEscape={onStay}
    actions={<>
      <button type="button" className={styles.danger} onClick={onLeave}>{vi ? 'Thoát và hủy lượt thi' : 'Leave and cancel the attempt'}</button>
      <button type="button" data-primary className={styles.primary} onClick={onStay}>{vi ? 'Ở lại tiếp tục' : 'Stay and continue'}</button>
    </>}>
    <p>{vi ? 'Bạn đang trong phiên thi có tính điểm. Nếu rời khỏi lúc này, lượt thi sẽ bị hủy và không được tính điểm. Bạn có chắc muốn thoát?'
      : 'You are in a scored contest. If you leave now the attempt is cancelled and does not score. Do you really want to leave?'}</p>
  </Modal>;
}

/** What a learner sees after the server ended the attempt for a session rule (never phrased as an accusation). */
export function AttemptVoided({ vi, state, duelContinues, onRestart, onLobby }: {
  vi: boolean; state: string; duelContinues?: boolean; onRestart?: () => void; onLobby: () => void;
}) {
  const continuity = state === 'VOIDED_CONTINUITY' || state === 'EXPIRED';
  const review = state === 'PENDING_REVIEW';
  return <Modal tone="void" icon={<ShieldX />} title={review ? (vi ? 'KẾT QUẢ ĐANG CHỜ XEM XÉT' : 'RESULT AWAITING REVIEW') : (vi ? 'LƯỢT THI ĐÃ BỊ HỦY' : 'ATTEMPT CANCELLED')}
    actions={<>
      <button type="button" className={styles.ghost} onClick={onLobby}>{vi ? 'Về sảnh' : 'Return to lobby'}</button>
      {onRestart && <button type="button" data-primary className={styles.primary} onClick={onRestart}>{vi ? 'Bắt đầu lượt mới' : 'Start a new attempt'}</button>}
    </>}>
    {review ? <p>{vi ? 'Nhịp thao tác của lượt này đều bất thường nên kết quả chưa được đưa lên bảng xếp hạng cho tới khi được xem xét. Điểm học tập khác không bị ảnh hưởng.'
      : 'The timing of this attempt was unusually regular, so its result stays off the leaderboard until it is reviewed. Nothing else is affected.'}</p>
      : continuity ? <p>{vi ? 'Hệ thống không thể xác nhận phiên thi được duy trì liên tục (ví dụ mất kết nối quá lâu). Lượt này không được tính điểm hoặc xếp hạng. Bạn cần bắt đầu lại từ đầu để nhận điểm.'
        : 'The session could not be confirmed as continuous (for example the connection was lost for too long). This attempt does not score or rank. Start again from the beginning to score.'}</p>
      : <p>{vi ? 'Hệ thống phát hiện phiên thi không còn đáp ứng quy định duy trì màn hình thi. Lượt này không được tính điểm hoặc xếp hạng. Bạn cần bắt đầu lại từ đầu để nhận điểm.'
        : 'The session no longer met the stay-on-screen rule. This attempt does not score or rank. Start again from the beginning to score.'}</p>}
    {duelContinues && <p className={styles.fine}>{vi ? 'Trận vẫn tiếp tục cho đối thủ của bạn.' : 'The match continues for your opponent.'}</p>}
  </Modal>;
}
