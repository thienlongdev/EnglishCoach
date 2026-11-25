'use client';

import React, { useEffect, useState } from 'react';
import { ECHO_ANYWHERE_STORES, browserKind, installDestination, detectEchoAnywhere, type InstallState } from '@/lib/echoAnywhere/client';
import styles from './echoAnywherePage.module.css';
import { ECHO_ANYWHERE_RELEASE as release, releaseVersionState } from '@/lib/echoAnywhere/release';

export function HeroInstallLink() {
  const [destination, setDestination] = useState<ReturnType<typeof installDestination>>(null);
  useEffect(() => { setDestination(installDestination(browserKind())); }, []);
  return <a id="cai-echo-anywhere" className={styles.primaryBtn} href={destination?.url ?? '#cai-dat'}
    target={destination ? '_blank' : undefined} rel={destination ? 'noopener noreferrer' : undefined}>Cài Echo Anywhere</a>;
}

/** Install options for THIS browser: a store link only when the listing really exists, the real install state otherwise. */
export function InstallPanel() {
  const [kind, setKind] = useState<'chrome' | 'edge' | 'other' | 'mobile' | null>(null);
  const [state, setState] = useState<InstallState>({ kind: 'checking' });

  useEffect(() => {
    setKind(browserKind());
    let alive = true;
    const refresh = () => { if (!document.hidden) detectEchoAnywhere().then((value) => { if (alive) setState(value); }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, []);

  const stores: { id: 'chrome' | 'edge'; name: string; url: string | null }[] = [
    { id: 'chrome', name: 'Google Chrome', url: ECHO_ANYWHERE_STORES.chrome },
    { id: 'edge', name: 'Microsoft Edge', url: ECHO_ANYWHERE_STORES.edge },
  ];
  const ordered = kind === 'edge' ? [stores[1], stores[0]] : stores;
  const destination = kind ? installDestination(kind) : null;
  const versionState = state.kind === 'installed' ? releaseVersionState(state.version) : 'unknown';
  const [changelogOpen, setChangelogOpen] = useState(false);
  useEffect(() => {
    const followHash = () => { if (window.location.hash === '#co-gi-moi') setChangelogOpen(true); };
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  return (
    <div className={styles.install} aria-live="polite">
      <div className={styles.installState} data-testid="echo-anywhere-install-state">
        {state.kind === 'checking' && 'Đang kiểm tra trình duyệt của bạn…'}
        {state.kind === 'installed' && <>
          <span className={styles.okText}>Đã cài Echo Anywhere{state.version && versionState !== 'unknown' ? ` ${state.version}` : ''} trên trình duyệt này.</span>
          <p className={styles.small}>{state.connected ? 'Tiện ích báo đã kết nối tài khoản English Coach. Xem tài khoản trong biểu tượng Echo; nếu phiên hết hạn, tiện ích sẽ yêu cầu kết nối lại.' : 'Đã cài nhưng chưa kết nối tài khoản. Bấm biểu tượng Echo → “Kết nối tài khoản” để bắt đầu lưu từ.'}</p>
          <p className={styles.small} data-testid="echo-anywhere-version-state">
            {versionState === 'current' && 'Phiên bản tiện ích phản hồi khớp bản phát hành mới nhất.'}
            {versionState === 'older' && `Bạn đang dùng ${state.version}. Trình duyệt có thể đang chờ cập nhật tự động lên ${release.version}; không cần gỡ hay cài lại.`}
            {versionState === 'newer' && 'Tiện ích phản hồi phiên bản mới hơn thông tin phát hành đã được website xác minh.'}
            {versionState === 'unknown' && 'Đã phát hiện tiện ích, nhưng chưa xác minh được phiên bản đang cài.'}
          </p>
        </>}
        {state.kind === 'not-detected' && 'Chưa phát hiện được Echo Anywhere trên trình duyệt này. Nếu chưa cài, dùng nút “Cài Echo Anywhere” ở đầu trang; nếu đã cài, hãy kiểm tra tiện ích đang bật. Website chưa thể xác nhận trạng thái cài đặt hoặc kết nối.'}
        {state.kind === 'unsupported' && (kind === 'mobile'
          ? 'Echo Anywhere dành cho máy tính. Hãy mở trang này trên Chrome hoặc Edge ở máy tính.'
          : 'Hãy dùng Chrome, Brave, Edge hoặc Cốc Cốc tương thích trên máy tính (Chromium 116 trở lên).')}
      </div>
      {destination && state.kind !== 'installed' && <div>
        <a href="#cai-echo-anywhere" className={styles.small}>Về nút cài đặt ở đầu trang</a>
        <p className={styles.small}>{kind === 'edge' && destination.store === 'chrome'
          ? 'Mở Chrome Web Store trong Edge. Nếu Edge yêu cầu, cho phép tiện ích từ cửa hàng khác, rồi xác nhận “Thêm tiện ích”.'
          : 'Cửa hàng chính thức sẽ mở. Trình duyệt yêu cầu bạn xác nhận thêm tiện ích; website không tự cài đặt.'}</p>
      </div>}
      <div className={styles.release}>
        <p><strong>Phiên bản mới nhất: {release.version}</strong></p>
        <p className={styles.small}>Đã phát hành trên Chrome Web Store · <time dateTime={release.publishedAt}>{release.publishedAt.split('-').reverse().join('/')}</time></p>
        <p className={styles.small}>Đã cài từ Chrome Web Store? Trình duyệt tự cập nhật, có thể đến dần khi tiện ích không còn hoạt động. Không cần gỡ hay cài lại: tài khoản đã ghép nối, cài đặt, từ đã lưu và dữ liệu học vẫn được giữ. Website không ép tải lại trong lúc bạn học và không thể hứa cập nhật ngay lập tức.</p>
        <details id="co-gi-moi" open={changelogOpen} onToggle={(e) => setChangelogOpen(e.currentTarget.open)}>
          <summary>Có gì mới?</summary>
          <p>{release.summary}</p>
          <ul className={styles.ticks}>{release.highlights.map((text) => <li key={text}>{text}</li>)}</ul>
          <p className={styles.small}>Premium bổ sung giải thích sâu và hỏi Echo về trích đoạn bạn chọn; chỉ chạy khi bạn yêu cầu, theo hạn mức hiện có. Không có kho lời nhạc được cấp phép hay trích lời Spotify tự động. Phụ đề phụ thuộc nguồn truy cập được, không có trên mọi video.</p>
          <p className={styles.small}>Đây là thông báo bản phát hành trên website; không phải xác nhận tiện ích của bạn đã cập nhật.</p>
        </details>
      </div>
      <div className={styles.storeRow}>
        {ordered.map((s) => (
          <div key={s.id} className={`${styles.store} ${kind === s.id ? styles.storeHere : ''}`}>
            <p className={styles.storeName}>{s.name}{kind === s.id ? ' · trình duyệt bạn đang dùng' : ''}</p>
            {s.url
              ? <p className={styles.pendingText}>{s.id === 'chrome' ? 'Chrome Web Store dành cho Chrome, Brave và Cốc Cốc tương thích.' : 'Có trên Microsoft Edge Add-ons.'}</p>
              : <p className={styles.pendingText}>{s.id === 'edge' && ECHO_ANYWHERE_STORES.chrome
                ? 'Edge tương thích có thể cài từ Chrome Web Store.'
                : 'Tiện ích chưa được công bố trên cửa hàng này.'}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
