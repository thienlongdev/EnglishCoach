'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import Link from 'next/link';
import { Music2, ArrowUpRight, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Volume1,
  Plus, ListMusic, Upload, Laptop, Search, X, Pencil, Trash2, ArrowUp, ArrowDown, ChevronRight, LoaderCircle, Headphones, Check, ExternalLink, Disc3 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { MUSIC_CATALOG, MOODS } from '@/lib/music/catalog';
import { clock, type MusicTrack } from '@/lib/music/model';
import { useMusic } from './MusicProvider';
import { MusicArtwork } from './MusicArtwork';
import MusicVisualizer from './MusicVisualizer';
import MusicCoverflow from './MusicCoverflow';
import styles from './Music.module.css';

const ERRORS: Record<string, [string, string]> = {
  STORAGE_UNAVAILABLE: ['Trình duyệt chưa cho phép lưu nhạc. Kiểm tra quyền lưu trữ hoặc chế độ riêng tư.', 'Browser storage is unavailable. Check storage permissions or private browsing.'],
  FILE_SIZE: ['Chọn tệp âm thanh không rỗng, tối đa 150 MB mỗi tệp.', 'Choose a non-empty audio file, up to 150 MB each.'],
  FILE_TYPE: ['Dùng MP3, M4A, AAC, WAV, OGG, Opus, FLAC hoặc WebM.', 'Use MP3, M4A, AAC, WAV, OGG, Opus, FLAC or WebM.'],
  FILE_CODEC: ['Trình duyệt không đọc được âm thanh này. Thử bản MP3 hoặc WAV.', 'Your browser cannot decode this recording. Try an MP3 or WAV copy.'],
  DECODE_TIMEOUT: ['Chưa đọc được thông tin tệp. Thử một tệp khác.', 'File metadata timed out. Try another file.'],
  LIBRARY_FULL: ['Thư viện đã đạt giới hạn 200 bài hoặc 1 GB. Xóa bớt bài để thêm nhạc.', 'Your library has reached 200 tracks or 1 GB. Remove a track to make room.'],
  FILE_MISSING: ['Tệp không còn trên trình duyệt này. Thêm lại bản nhạc từ thiết bị.', 'This file is no longer in this browser. Import it again from your device.'],
  PLAYBACK_FAILED: ['Chưa phát được bài này. Thử phát lại hoặc chọn bài khác; nguồn nhạc có thể tạm gián đoạn.', 'This track could not play. Retry or choose another; the music source may be temporarily unavailable.'],
  TAP_TO_PLAY: ['Nhấn Phát để tiếp tục. Trình duyệt cần thao tác của bạn.', 'Press Play to continue. Your browser needs a user gesture.'],
  ACCOUNT_REQUIRED: ['Đăng nhập để lưu bộ sưu tập nhạc của riêng bạn.', 'Sign in to keep your personal collection.'],
};
const CATALOG_IDS = MUSIC_CATALOG.map(t => t.id);
const byId = (id: string) => MUSIC_CATALOG.find(t => t.id === id) ?? MUSIC_CATALOG[0];

export default function MusicHub() {
  const music = useMusic(); const { engine } = music;
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const [section, setSection] = useState<'discover' | 'mine'>('discover');
  const [mood, setMood] = useState('all'); const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<MusicTrack | null>(null); const [remove, setRemove] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLElement>(null);
  const tiltFrame = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [mutedVolume, setMutedVolume] = useState(.45);
  const track = music.current ?? MUSIC_CATALOG[0];
  const layers = useCrossfade(track);
  const moodLabel = (item: MusicTrack) => item.source === 'local' ? (vi ? 'Nhạc của tôi' : 'My Music') : MOODS.find(m => m.id === item.mood)?.[vi ? 'vi' : 'en'] ?? '';
  const tracks = (section === 'mine' ? music.library : MUSIC_CATALOG).filter(t => (mood === 'all' || section === 'mine' || t.mood === mood) && `${t.title} ${t.artist}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const queue = music.queue.length ? music.queue.map(id => engine?.track(id)).filter((t): t is MusicTrack => !!t) : MUSIC_CATALOG;
  const active = music.current?.id === track.id;
  const play = () => active ? engine?.toggle() : void engine?.select(track.id, CATALOG_IDS);
  const playFromFlow = (id: string) => music.current?.id === id ? engine?.toggle() : void engine?.select(id, CATALOG_IDS);
  const importFiles = (files: FileList | File[]) => { setSection('mine'); setSearch(''); void engine?.importFiles(Array.from(files)); };
  const message = music.error ? (ERRORS[music.error] ?? ['Không thể hoàn tất. Thử lại hoặc kiểm tra dung lượng trình duyệt.', 'Unable to complete. Retry or check browser storage.'])[vi ? 0 : 1] : null;
  const progress = active && music.duration ? Math.min(1, music.time / music.duration) : 0;
  const at = music.current ? music.queue.indexOf(music.current.id) : -1;
  const upNext = at >= 0 && music.queue.length > 1 && !music.shuffle && (music.repeat === 'all' || at < music.queue.length - 1) ? engine?.track(music.queue[(at + 1) % music.queue.length]) : undefined;
  const changeSourceByKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'discover' : event.key === 'End' ? 'mine' : section === 'mine' ? 'discover' : 'mine';
    setSection(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#music-tab-${next}`)?.focus();
  };
  // The record leans toward a fine pointer (desktop only); one style write per frame at most.
  const tilt = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || !stage.current || tiltFrame.current) return;
    const { clientX, clientY } = event;
    tiltFrame.current = requestAnimationFrame(() => {
      tiltFrame.current = 0; const el = stage.current; if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--tx', ((clientX - r.left) / r.width - .5).toFixed(3));
      el.style.setProperty('--ty', ((clientY - r.top) / r.height - .5).toFixed(3));
    });
  };
  const untilt = () => { cancelAnimationFrame(tiltFrame.current); tiltFrame.current = 0; stage.current?.style.setProperty('--tx', '0'); stage.current?.style.setProperty('--ty', '0'); };
  useEffect(() => () => cancelAnimationFrame(tiltFrame.current), []);
  const statusLabel = music.focus ? (vi ? 'Tạm dừng để học' : 'Paused for learning') : music.playing ? (vi ? 'Đang phát' : 'Now playing') : music.loading ? (vi ? 'Đang mở' : 'Opening') : active ? (vi ? 'Đã tạm dừng' : 'Paused') : (vi ? 'Sẵn sàng' : 'Ready');

  return <div className={styles.hub} data-testid="music-hub" data-playing={music.playing} style={{ '--music-accent': track.accent } as CSSProperties}>
    <div className={styles.ambient} aria-hidden="true">
      {layers.map((layer, index) => <MusicArtwork key={layer.id} track={layer} decorative className={`${styles.ambientArt} ${index === layers.length - 1 ? styles.ambientIn : styles.ambientOut}`} />)}
      <span className={styles.blobA} /><span className={styles.blobB} /><span className={styles.blobC} /><span className={styles.grain} />
    </div>
    <div className={styles.hubInner}>
      <div className={styles.roomHeading}>
        <div>
          <div className={styles.eyebrow}><span className={styles.wordmark}><Music2 size={14} /> ECHO MUSIC</span><span className={styles.headingLine} />{vi ? 'KHÔNG GIAN CỦA BẠN' : 'YOUR LISTENING SPACE'}</div>
          <h1>{vi ? 'Tìm nhịp điệu' : 'Find your'} <em>{vi ? 'của riêng bạn.' : 'own rhythm.'}</em></h1>
          <p>{vi ? 'Gác lại ồn ào. Để những giai điệu đưa bạn vào mạch học.' : 'Leave the noise behind. Let a little music carry you into focus.'}</p>
        </div>
        <Link href="/dashboard" prefetch={false} className={styles.returnLink}>{vi ? 'Về học, vẫn nghe nhạc' : 'Back to learning, music on'}<ArrowUpRight size={15} /></Link>
      </div>

      <section ref={stage} className={styles.nowPlaying} aria-label={vi ? 'Đang phát' : 'Now playing'} data-testid="music-now-playing" data-playing={music.playing} onPointerMove={tilt} onPointerLeave={untilt}>
        <span className={styles.stageLight} aria-hidden="true" /><span className={styles.rimFlow} aria-hidden="true"><i /></span>
        <div className={styles.artStage}>
          <div className={styles.record} data-spinning={music.playing}>
            <span className={styles.floorGlow} aria-hidden="true" />
            <div className={styles.vinyl} aria-hidden="true"><span className={styles.grooves} /><MusicArtwork key={track.id} track={track} decorative className={styles.label} /><span className={styles.spindle} /><span className={styles.vinylSheen} /></div>
            <div key={track.id} className={styles.sleeve}><MusicArtwork track={track} priority /><span className={styles.sleeveSheen} aria-hidden="true" /></div>
          </div>
        </div>
        <div className={styles.nowDetails}>
          <div className={styles.chips}>
            <span className={styles.statusChip} data-live={music.playing || undefined}><span className={styles.liveDot} />{statusLabel}</span>
            <span className={styles.chip}>{moodLabel(track)}</span>
            <span className={`${styles.chip} ${styles.sourceChip}`}>{track.source === 'local' ? (vi ? 'Từ thiết bị của bạn' : 'From your device') : (vi ? 'Tuyển chọn' : 'Curated')}</span>
            {upNext && <button className={styles.upNext} onClick={() => void engine?.next()} aria-label={`${vi ? 'Phát bài tiếp theo' : 'Play next'}: ${upNext.title}`} data-testid="music-up-next">
              <MusicArtwork track={upNext} decorative className={styles.upNextArt} /><span><small>{vi ? 'Tiếp theo' : 'Up next'}</small><strong>{upNext.title}</strong></span><SkipForward size={13} fill="currentColor" />
            </button>}
          </div>
          <h2 key={track.id} className={styles.nowTitle}>{track.title}</h2>
          <p className={styles.artist}>{track.artist || (vi ? 'Bộ sưu tập của bạn' : 'Your personal collection')}</p>
          <div className={styles.seekRow}>
            <span>{clock(active ? music.time : 0)}</span>
            <input className={styles.range} style={{ '--p': `${progress * 100}%` } as CSSProperties} aria-label={vi ? 'Vị trí phát' : 'Playback position'} type="range" min={0} max={Math.max(1, music.duration)} step={.1} value={Math.min(music.time, Math.max(1, music.duration))} onChange={e => engine?.seek(Number(e.target.value))} disabled={!active || !music.duration} />
            <span>{active && music.duration ? clock(music.duration) : '—:—'}</span>
          </div>
          <div className={styles.transport}>
            <button className={styles.subControl} onClick={() => engine?.shuffle()} aria-pressed={music.shuffle} aria-label={vi ? 'Phát ngẫu nhiên' : 'Shuffle'} title={vi ? 'Phát ngẫu nhiên' : 'Shuffle'}><Shuffle size={18} /></button>
            <button className={styles.skipControl} onClick={() => void engine?.next(-1)} aria-label={vi ? 'Bài trước' : 'Previous track'} disabled={!music.current}><SkipBack size={22} fill="currentColor" /></button>
            <button className={styles.mainPlay} onClick={play} disabled={!engine || !!music.focus} aria-label={music.playing ? (vi ? 'Tạm dừng' : 'Pause') : (vi ? 'Phát ngay' : 'Play now')} data-testid="music-play">
              <span className={styles.halo} aria-hidden="true" />
              {music.loading ? <LoaderCircle size={26} className={styles.spinner} /> : music.playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" className={styles.playNudge} />}
            </button>
            <button className={styles.skipControl} onClick={() => void engine?.next()} aria-label={vi ? 'Bài tiếp theo' : 'Next track'} disabled={!music.current}><SkipForward size={22} fill="currentColor" /></button>
            <button className={styles.subControl} onClick={() => engine?.repeat()} aria-pressed={music.repeat !== 'off'} aria-label={vi ? `Lặp: ${music.repeat === 'one' ? 'một bài' : music.repeat === 'all' ? 'cả danh sách' : 'tắt'}` : `Repeat: ${music.repeat}`} title={vi ? 'Chuyển chế độ lặp' : 'Change repeat mode'}>{music.repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}</button>
          </div>
          <MusicVisualizer vi={vi} />
          <div className={styles.nowFooter}>
            <div className={styles.volume}>
              <button onClick={() => { if (music.volume) { setMutedVolume(music.volume); engine?.volume(0); } else engine?.volume(mutedVolume || .45); }} aria-label={music.volume ? (vi ? 'Tắt tiếng' : 'Mute') : (vi ? 'Bật tiếng' : 'Unmute')}>{!music.volume ? <VolumeX size={16} /> : music.volume < .5 ? <Volume1 size={16} /> : <Volume2 size={16} />}</button>
              <input className={styles.range} style={{ '--p': `${music.volume * 100}%` } as CSSProperties} type="range" min={0} max={1} step={.01} value={music.volume} onChange={e => engine?.volume(Number(e.target.value))} aria-label={vi ? 'Âm lượng' : 'Volume'} />
            </div>
            {track.creditUrl ? <a href={track.creditUrl} target="_blank" rel="noreferrer" className={styles.credit}>Scott Buckley · CC BY 4.0 <ExternalLink size={11} /></a> : <span className={styles.credit}><Laptop size={12} />{vi ? 'Chỉ trên trình duyệt này' : 'Only in this browser'}</span>}
          </div>
        </div>
      </section>

      {music.focus && <div role="status" className={styles.notice}><Headphones size={16} /><span>{vi ? 'Nhạc đang tạm dừng để nhường âm thanh cho hoạt động học. Khi quay lại, nhấn Phát để tiếp tục.' : 'Music is paused to make room for learning audio. Press Play when you return.'}</span></div>}
      {(message || music.importResult) && <div role={message ? 'alert' : 'status'} className={styles.notice} data-testid="music-notice"><span>{message}{music.importResult && <span> {vi ? `Đã thêm ${music.importResult.added} bài${music.importResult.failed ? ` · ${music.importResult.failed} tệp chưa thêm được` : ''}.` : `Added ${music.importResult.added} tracks${music.importResult.failed ? ` · ${music.importResult.failed} files could not be added` : ''}.`}</span>}</span><button onClick={() => engine?.dismissError()} aria-label={vi ? 'Đóng thông báo' : 'Dismiss notice'}><X size={16} /></button></div>}

      <section className={styles.discovery} aria-label={vi ? 'Khám phá tuyển chọn' : 'Curated discovery'}>
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>{vi ? 'KHÁM PHÁ TUYỂN CHỌN' : 'CURATED DISCOVERY'}</span><h2>{vi ? 'Bạn muốn nghe gì hôm nay?' : 'What does today sound like?'}</h2></div><span className={styles.collectionCount}>{MUSIC_CATALOG.length} {vi ? 'bản thu gốc · kéo hoặc dùng phím ← →' : 'original recordings · drag or use ← →'}</span></div>
        <MusicCoverflow tracks={MUSIC_CATALOG} currentId={music.current?.id} playing={music.playing} vi={vi} moodLabel={moodLabel} onPlay={playFromFlow} />
      </section>

      <section className={styles.collections} aria-label={vi ? 'Bộ sưu tập tuyển chọn' : 'Curated collections'}>
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>{vi ? 'MỘT TÂM TRẠNG. MỘT KHÔNG GIAN.' : 'A MOOD. A WORLD OF YOUR OWN.'}</span><h2>{vi ? 'Bộ sưu tập' : 'Collections'}</h2></div></div>
        <div className={styles.collectionGrid}>
          {[
            { title: vi ? 'Những phím bình yên' : 'Quiet keys', note: 'PIANO AND CALM', ids: ['sb-reverie', 'sb-jul'], tone: '#c5a1ef' },
            { title: vi ? 'Trôi giữa ngân hà' : 'Beyond the noise', note: 'AMBIENT AND FOCUS', ids: ['sb-adrift', 'sb-undertow', 'sb-solitude'], tone: '#8cc4d8' },
            { title: vi ? 'Khi thành phố ngủ' : 'After hours', note: 'NIGHT STUDY', ids: ['sb-moonlight', 'sb-reverie', 'sb-undertow'], tone: '#a9b4f0' },
          ].map(collection => {
            const live = music.playing && !!music.current && collection.ids.includes(music.current.id) && music.queue.join() === collection.ids.join();
            return <button key={collection.note} className={styles.collectionCard} data-live={live || undefined} onClick={() => live ? engine?.pause() : void engine?.select(collection.ids[0], collection.ids)} style={{ '--collection-tone': collection.tone } as CSSProperties} aria-label={`${live ? (vi ? 'Tạm dừng bộ sưu tập' : 'Pause collection') : (vi ? 'Phát bộ sưu tập' : 'Play collection')} ${collection.title}`}>
              <span className={styles.collectionGlow} aria-hidden="true" />
              <span className={styles.fan} aria-hidden="true">{collection.ids.slice(0, 3).map(id => <MusicArtwork key={id} track={byId(id)} decorative className={styles.fanCover} />).reverse()}</span>
              <span className={styles.collectionCopy}><small>{collection.note}</small><strong>{collection.title}</strong><span>{collection.ids.length} {vi ? 'bài · không lời' : 'tracks · instrumental'}</span></span>
              <span className={styles.collectionPlay}>{live ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</span>
            </button>;
          })}
        </div>
      </section>

      <div className={styles.libraryGrid}>
        <section className={styles.library} aria-label={vi ? 'Thư viện âm nhạc' : 'Music library'}>
          <div className={styles.libraryTop}>
            <div role="tablist" aria-label={vi ? 'Nguồn nhạc' : 'Music sources'} data-guide="music-sources" className={styles.sourceTabs} data-section={section}>
              <span className={styles.tabThumb} aria-hidden="true" />
              <button role="tab" id="music-tab-discover" aria-controls="music-library-panel" tabIndex={section === 'discover' ? 0 : -1} onKeyDown={changeSourceByKey} aria-selected={section === 'discover'} onClick={() => setSection('discover')} data-testid="music-curated-tab"><Disc3 size={15} />{vi ? 'Khám phá' : 'Discover'}<span>{MUSIC_CATALOG.length}</span></button>
              <button role="tab" id="music-tab-mine" aria-controls="music-library-panel" tabIndex={section === 'mine' ? 0 : -1} onKeyDown={changeSourceByKey} aria-selected={section === 'mine'} onClick={() => setSection('mine')} data-testid="music-mine-tab"><Laptop size={15} />{vi ? 'Nhạc của tôi' : 'My Music'}<span>{music.library.length}</span></button>
            </div>
            <button className={styles.importButton} onClick={() => fileInput.current?.click()} disabled={!engine?.scope || music.importing} data-testid="music-import">{music.importing ? <LoaderCircle size={15} className={styles.spinner} /> : <Plus size={16} />}{vi ? 'Thêm nhạc' : 'Import music'}</button>
          </div>
          <input type="file" ref={fileInput} accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,.webm" multiple hidden data-testid="music-file-input" onChange={e => { if (e.target.files) importFiles(e.target.files); e.target.value = ''; }} />
          <div className={styles.filters}>
            {section === 'discover' ? <div className={styles.moods}>{MOODS.map(m => <button key={m.id} onClick={() => setMood(m.id)} aria-pressed={mood === m.id}>{m[vi ? 'vi' : 'en']}</button>)}</div> : <div className={styles.deviceNote}><Laptop size={15} /><span>{vi ? 'Của riêng bạn, trên trình duyệt này. Tệp không tải lên máy chủ; xóa dữ liệu trình duyệt sẽ xóa thư viện. Hãy giữ bản gốc.' : 'Yours, in this browser. Files are never uploaded; clearing browser data removes the library. Keep your originals.'}</span></div>}
            <label className={styles.searchField}><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder={vi ? 'Tìm bài hát, nghệ sĩ…' : 'Find a track or artist…'} aria-label={vi ? 'Tìm trong thư viện' : 'Search library'} />{search && <button onClick={() => setSearch('')} aria-label={vi ? 'Xóa tìm kiếm' : 'Clear search'}><X size={14} /></button>}</label>
          </div>
          <div role="tabpanel" id="music-library-panel" aria-labelledby={`music-tab-${section}`} className={`${styles.trackList} ${dragging ? styles.dropActive : ''}`} onDragOver={e => { e.preventDefault(); if (section === 'mine') setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (engine?.scope && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); }}>
            {!music.ready && section === 'mine' ? <div className={styles.empty}><LoaderCircle className={styles.spinner} /><h3>{vi ? 'Đang mở bộ sưu tập…' : 'Opening your collection…'}</h3></div> : tracks.length ? tracks.map((item, index) => <div key={item.id} className={styles.trackRow} data-active={music.current?.id === item.id} data-track-id={item.id} style={{ '--music-accent': item.accent, '--row': index } as CSSProperties}>
              <button className={styles.trackSelect} onClick={() => music.current?.id === item.id ? engine?.toggle() : void engine?.select(item.id, tracks.map(t => t.id))} aria-label={`${music.current?.id === item.id && music.playing ? (vi ? 'Tạm dừng' : 'Pause') : (vi ? 'Phát' : 'Play')} ${item.title}`}>
                <span className={styles.trackNumber}>{music.current?.id === item.id && music.playing ? <AudioPulse /> : String(index + 1).padStart(2, '0')}</span>
                <span className={styles.trackArtWrap}><MusicArtwork track={item} className={styles.trackArt} /><span className={styles.trackArtPlay} aria-hidden="true">{music.current?.id === item.id && music.playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</span></span>
                <span className={styles.trackMeta}><strong>{item.title}</strong><small>{item.artist || (vi ? 'Tệp trên thiết bị' : 'Device file')}</small></span>
              </button>
              <span className={styles.trackMood}>{section === 'mine' ? clock(item.duration) : MOODS.find(m => m.id === item.mood)?.[vi ? 'vi' : 'en']}</span>
              {section === 'mine' ? <div className={styles.rowActions}><button aria-label={`${vi ? 'Sửa thông tin' : 'Edit details'} ${item.title}`} onClick={() => setEdit(item)}><Pencil size={14} /></button><button aria-label={`${vi ? 'Xóa' : 'Delete'} ${item.title}`} onClick={() => setRemove(remove === item.id ? null : item.id)}><Trash2 size={14} /></button></div> : <button className={styles.addQueue} onClick={() => engine?.enqueue(item.id)} aria-label={`${vi ? 'Thêm vào hàng đợi' : 'Add to queue'} ${item.title}`} title={vi ? 'Thêm vào hàng đợi' : 'Add to queue'}>{music.queue.includes(item.id) ? <Check size={15} /> : <Plus size={16} />}</button>}
              {remove === item.id && <div className={styles.deleteConfirm}><span>{vi ? 'Xóa bản nhạc khỏi trình duyệt này?' : 'Remove this recording from this browser?'}</span><button onClick={() => { void engine?.delete(item.id); setRemove(null); }}>{vi ? 'Xóa' : 'Remove'}</button><button onClick={() => setRemove(null)}>{vi ? 'Giữ lại' : 'Keep'}</button></div>}
              {edit?.id === item.id && <form className={styles.editForm} onSubmit={e => { e.preventDefault(); void engine?.edit(edit.id, edit.title, edit.artist); setEdit(null); }}><input autoFocus value={edit.title} maxLength={160} onChange={e => setEdit({ ...edit, title: e.target.value })} aria-label={vi ? 'Tên bài hát' : 'Track title'} required /><input value={edit.artist} maxLength={120} onChange={e => setEdit({ ...edit, artist: e.target.value })} aria-label={vi ? 'Nghệ sĩ' : 'Artist'} placeholder={vi ? 'Nghệ sĩ' : 'Artist'} /><button type="submit">{vi ? 'Lưu' : 'Save'}</button><button type="button" onClick={() => setEdit(null)}>{vi ? 'Hủy' : 'Cancel'}</button></form>}
            </div>) : <div className={styles.empty}>
              {search || (section === 'discover' && mood !== 'all') ? <><Search size={28} /><h3>{vi ? 'Chưa tìm thấy giai điệu này' : 'No matching tracks'}</h3><button onClick={() => { setSearch(''); setMood('all'); }}>{vi ? 'Xem tất cả' : 'Show all tracks'}</button></> : <><div className={styles.emptyDisc}><span /><Music2 size={26} /></div><h3>{vi ? 'Mang thế giới âm nhạc của bạn vào đây.' : 'Bring your world of music here.'}</h3><p>{vi ? 'Kéo thả tệp vào đây hoặc chọn từ thiết bị. MP3, M4A, WAV, FLAC… · tối đa 150 MB/tệp. Tệp ở lại trên trình duyệt này.' : 'Drop files here or choose from your device. MP3, M4A, WAV, FLAC… · up to 150 MB/file. Files stay in this browser.'}</p><button onClick={() => fileInput.current?.click()} disabled={!engine?.scope || music.importing}><Upload size={15} />{music.importing ? (vi ? 'Đang thêm…' : 'Importing…') : (vi ? 'Chọn bản nhạc của bạn' : 'Choose your music')}</button></>}
            </div>}
          </div>
          <div className={styles.libraryFoot}>{section === 'mine' ? <><Laptop size={12} />{vi ? 'Tối đa 200 bài · 1 GB · không đồng bộ thiết bị' : 'Up to 200 tracks · 1 GB · device-local'}</> : <><a href="https://www.scottbuckley.com.au/library/" target="_blank" rel="noreferrer">{vi ? 'Âm nhạc và ảnh bìa: Scott Buckley' : 'Music and cover artwork: Scott Buckley'} <ArrowUpRight size={12} /></a><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">{vi ? 'Nhạc: CC BY 4.0 · bản thu nguyên gốc' : 'Music: CC BY 4.0 · original recordings'}</a></>}</div>
        </section>

        <aside className={styles.queue} aria-label={vi ? 'Hàng đợi phát' : 'Playback queue'}>
          <div className={styles.queueHeading}><div><span className={styles.queueIcon}><ListMusic size={17} /></span><h2>{vi ? 'Tiếp theo' : 'Up next'}</h2></div><span>{queue.length}</span></div>
          <p>{vi ? 'Cứ để cảm hứng tiếp nối.' : 'Keep the feeling going.'}</p>
          <div className={styles.queueList}>{queue.map((item, index) => <div className={styles.queueRow} key={item.id} data-active={music.current?.id === item.id} style={{ '--music-accent': item.accent } as CSSProperties}>
            <button className={styles.queueSelect} onClick={() => void engine?.select(item.id, queue.map(t => t.id))} aria-label={`${vi ? 'Phát' : 'Play'} ${item.title}`}><MusicArtwork track={item} className={styles.queueArt} /><span><strong>{item.title}</strong><small>{music.current?.id === item.id ? (vi ? 'Bản nhạc hiện tại' : 'Current track') : item.artist || (vi ? 'Nhạc của tôi' : 'My Music')}</small></span>{music.current?.id === item.id && music.playing && <AudioPulse />}</button>
            {music.queue.length > 0 && <div className={styles.queueActions}><button onClick={() => engine?.moveQueue(item.id, -1)} disabled={!index} aria-label={`${vi ? 'Đưa lên' : 'Move up'} ${item.title}`}><ArrowUp size={12} /></button><button onClick={() => engine?.moveQueue(item.id, 1)} disabled={index === queue.length - 1} aria-label={`${vi ? 'Đưa xuống' : 'Move down'} ${item.title}`}><ArrowDown size={12} /></button>{item.id !== music.current?.id && <button onClick={() => engine?.removeQueue(item.id)} aria-label={`${vi ? 'Bỏ khỏi hàng đợi' : 'Remove from queue'} ${item.title}`}><X size={12} /></button>}</div>}
          </div>)}</div>
          <div className={styles.continuityNote}><span className={styles.continuityIcon}><Headphones size={19} /></span><strong>{vi ? 'Giai điệu theo bạn.' : 'Your music comes along.'}</strong><p>{vi ? 'Chuyển trang, giữ mạch cảm hứng. Trình phát nằm gọn cạnh ô tra từ trên thanh trên cùng, thu nhỏ thành một viên nhỏ khi bạn cần.' : 'Move between pages without missing a beat. The player sits beside the dictionary in the top bar and folds into a small pill.'}</p><Link href="/dashboard" prefetch={false}>{vi ? 'Trở lại không gian học' : 'Back to your workspace'}<ChevronRight size={14} /></Link></div>
        </aside>
      </div>
      <footer className={styles.roomFooter}><Music2 size={13} /><span>ECHO MUSIC</span><i />{vi ? 'Một không gian để tập trung. Một khoảng lặng để là mình.' : 'A space to focus. A moment to be yourself.'}</footer>
    </div>
  </div>;
}

/** Keeps the previous cover light for one cross-fade, then lets it go (at most two layers). */
function useCrossfade(track: MusicTrack) {
  const [layers, setLayers] = useState<MusicTrack[]>([track]);
  useEffect(() => { setLayers(now => now[now.length - 1].id === track.id ? now : [now[now.length - 1], track]); }, [track]);
  return layers;
}
function AudioPulse() { return <span className={styles.audioPulse} aria-hidden="true"><i /><i /><i /></span>; }
