'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { ArrowLeft, BookOpen, Bot, History, Link2, Play, Plus, ScrollText, Swords, Trophy, User, Users, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { apiClient } from '@/services/api-client';
import { useWordChain } from './useWordChain';
import { WordChainArena, Summary } from './WordChainArena';
import { ERRORS, LEVEL_LABEL, MODE_LABEL, WORD_ERRORS, t } from './copy';
import { WORD_CHAIN_ART, WORD_CHAIN_MODE_ART } from './wordChainArt';
import type { BotLevel, ChainState, HistoryRow } from './types';
import styles from './wordChain.module.css';

type Pace = 'STANDARD' | 'RELAXED';
const TONE: Record<string, string> = { SOLO: 'solo', BOT: 'bot', QUICK: 'quick', PRIVATE: 'private' };
const MODE_ICON = { SOLO: User, BOT: Bot, QUICK: Swords, PRIVATE: Users } as const;

function PaceSwitch({ vi, value, onChange }: { vi: boolean; value: Pace; onChange: (p: Pace) => void }) {
  return (
    <div className={styles.seg} role="group" aria-label={vi ? 'Thời gian mỗi lượt' : 'Time per turn'}>
      <button type="button" aria-pressed={value === 'STANDARD'} onClick={() => onChange('STANDARD')}>{vi ? '30 giây' : '30 s'}</button>
      <button type="button" aria-pressed={value === 'RELAXED'} onClick={() => onChange('RELAXED')}>{vi ? '45 giây' : '45 s'}</button>
    </div>
  );
}

export function WordChainGame() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const { data: session } = useSession();
  const scope = (session?.user as { id?: string } | undefined)?.id || session?.user?.email;
  const { state, connected, pending, error, errorId, serverOffset, send } = useWordChain();

  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState('');
  const [soloPace, setSoloPace] = useState<Pace>('STANDARD');
  const [botPace, setBotPace] = useState<Pace>('STANDARD');
  const [roomPace, setRoomPace] = useState<Pace>('STANDARD');
  const [level, setLevel] = useState<BotLevel>('MEDIUM');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [archived, setArchived] = useState<ChainState | null>(null);
  const [archiveError, setArchiveError] = useState(false);

  useEffect(() => {
    if (state?.status !== 'ACTIVE') return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state?.status]);

  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get('invite');
    if (invite) setCode(invite.toUpperCase().slice(0, 8));
  }, []);

  useEffect(() => {
    if (!scope || state?.status === 'ACTIVE') return;
    const abort = new AbortController();
    setHistoryState('loading');
    void apiClient
      .get<HistoryRow[]>('/word-chain/history', { signal: abort.signal, timeout: 10000 })
      .then(r => { setHistory(Array.isArray(r.data) ? r.data : []); setHistoryState('ready'); })
      .catch(() => { if (!abort.signal.aborted) setHistoryState('error'); });
    return () => abort.abort();
  }, [scope, state?.status, state?.resultSaved]);

  const record = useMemo(() => ({
    matches: history.length,
    best: history.reduce((m, h) => Math.max(m, h.acceptedCount), 0),
    words: history.reduce((m, h) => m + h.acceptedCount, 0),
  }), [history]);

  const total = state?.turnSeconds ?? (state?.difficulty === 'RELAXED' ? 45 : 30);
  const seconds = state ? Math.min(total, Math.max(0, Math.ceil((state.deadline - now - serverOffset) / 1000))) : 0;
  const disabled = !connected || pending;
  const pageError = error && !(state?.status === 'ACTIVE' && WORD_ERRORS.has(error)) ? error : null;

  const openArchive = (matchId: string) => {
    setArchiveError(false);
    void apiClient.get<ChainState>(`/word-chain/results/${matchId}`, { timeout: 10000 })
      .then(r => setArchived(r.data)).catch(() => setArchiveError(true));
  };

  return (
    <div className={styles.world}>
      <div className={styles.sea} aria-hidden="true" />
      <div className={styles.page}>
        <div className={styles.topRow}>
          <Link href="/games" className={styles.pill}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{vi ? 'Thư viện trò chơi' : 'Games library'}</Link>
          {!state && (
            <span className={styles.pill} role="status">
              <span className={styles.dot} data-on={connected} />
              {connected ? (vi ? 'Máy chủ trò chơi sẵn sàng' : 'Game server ready') : (vi ? 'Đang kết nối máy chủ…' : 'Connecting…')}
            </span>
          )}
        </div>

        {pageError && (
          <div role="alert" className={styles.alert}>
            <span>{t(vi, ERRORS[pageError] || ERRORS.SERVER_UNAVAILABLE)}</span>
          </div>
        )}

        {state ? (
          <WordChainArena state={state} vi={vi} connected={connected} pending={pending} error={error} errorId={errorId} seconds={seconds} send={send} />
        ) : (
          <>
            <header className={styles.hero}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.heroArt} src={WORD_CHAIN_ART.hero} alt="" aria-hidden="true" fetchPriority="high" />
              <span className={styles.heroScrim} aria-hidden="true" />
              <div className={styles.heroBody}>
                <span className={styles.eyebrow}><Link2 className="h-3.5 w-3.5" aria-hidden="true" />Echo World · Word Chain</span>
                <h1 className={styles.title} data-guide="wcg-lobby">{vi ? 'Nối từ' : 'Word Chain'}</h1>
                <p className={styles.lede}>
                  {vi ? 'Gọi lại những từ tiếng Anh bạn biết và nối chúng thành chuỗi: chữ cái cuối của từ trước là chữ cái đầu của từ sau. Mỗi từ hiện kèm nghĩa tiếng Việt để bạn ôn ngay trong ván.'
                    : 'Recall the English words you know and link them into a chain: the last letter of one word starts the next. Every word comes with its Vietnamese meaning, so you review as you play.'}
                </p>
                <div className={styles.exampleChain} data-guide="wcg-example" aria-label={vi ? 'Ví dụ: tree, energy, yellow' : 'Example: tree, energy, yellow'}>
                  <b lang="en">tre<i>e</i></b><span aria-hidden="true">→</span><b lang="en"><i>e</i>nerg<i>y</i></b><span aria-hidden="true">→</span><b lang="en"><i>y</i>ellow</b>
                </div>
                <div className={styles.steps}>
                  <span className={styles.step}><span className={styles.stepNum}>1</span>{vi ? 'Chọn chế độ' : 'Pick a mode'}</span>
                  <span className={styles.step}><span className={styles.stepNum}>2</span>{vi ? 'Nhập từ bắt đầu bằng chữ được giao' : 'Type a word with the given letter'}</span>
                  <span className={styles.step}><span className={styles.stepNum}>3</span>{vi ? '+10 điểm mỗi từ hợp lệ' : '+10 points per valid word'}</span>
                </div>
              </div>
            </header>

            <div className={styles.modes} data-guide="wcg-modes">
              <ModeCard mode="SOLO" vi={vi} tag={vi ? 'Luyện tập' : 'Practice'}
                text={vi ? 'Tự nối chuỗi dài nhất có thể. Ván kết thúc khi hết giờ của một lượt hoặc khi bạn dừng.' : 'Build the longest chain you can. The match ends when a turn runs out of time or you stop.'}
                facts={[vi ? 'Chữ mở đầu ngẫu nhiên A–Z' : 'Random A–Z start', vi ? 'Không lặp từ' : 'No repeats']}>
                <span className={styles.fieldLabel}>{vi ? 'Thời gian mỗi lượt' : 'Time per turn'}</span>
                <PaceSwitch vi={vi} value={soloPace} onChange={setSoloPace} />
                <span className={styles.spacer} />
                <button type="button" className={styles.cta} disabled={disabled} onClick={() => send('start', { mode: 'SOLO', difficulty: soloPace })}>
                  <Play className="h-5 w-5" aria-hidden="true" />{vi ? 'Bắt đầu luyện tập' : 'Start practice'}
                </button>
              </ModeCard>

              <ModeCard mode="BOT" vi={vi} tag={vi ? 'Thử thách' : 'Challenge'}
                text={vi ? 'Đấu lượt với Echo. Echo chỉ dùng từ hợp lệ như bạn; cấp độ quyết định độ khó của từ Echo chọn.' : 'Take turns with Echo. Echo plays only valid words, like you; the level sets how hard its words are.'}
                facts={[vi ? 'Dễ: A1–A2' : 'Easy: A1–A2', vi ? 'Vừa: đến B1' : 'Medium: up to B1', vi ? 'Khó: B1 trở lên' : 'Hard: B1 and up']}>
                <span className={styles.fieldLabel}>{vi ? 'Cấp độ của Echo' : 'Echo level'}</span>
                <div className={styles.seg} role="group" aria-label={vi ? 'Cấp độ của Echo' : 'Echo level'}>
                  {(['EASY', 'MEDIUM', 'HARD'] as BotLevel[]).map(l => (
                    <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)}>{t(vi, LEVEL_LABEL[l])}</button>
                  ))}
                </div>
                <PaceSwitch vi={vi} value={botPace} onChange={setBotPace} />
                <span className={styles.spacer} />
                <button type="button" className={styles.cta} disabled={disabled} onClick={() => send('start', { mode: 'BOT', difficulty: botPace, level })}>
                  <Play className="h-5 w-5" aria-hidden="true" />{vi ? 'Chơi cùng Echo' : 'Play Echo'}
                </button>
              </ModeCard>

              <ModeCard mode="QUICK" vi={vi} tag={vi ? 'Trực tuyến' : 'Online'}
                text={vi ? 'Tự ghép với một người chơi đang chờ. Cả hai bấm Sẵn sàng là vào ván; hết giờ ở lượt của mình là thua.' : 'Pair with a waiting player. Both press Ready to start; running out of time on your turn loses.'}
                facts={[vi ? '2 người' : '2 players', vi ? '30 giây mỗi lượt' : '30 s per turn']}>
                <span className={styles.spacer} />
                <button type="button" className={styles.cta} disabled={disabled} onClick={() => send('quick')}>
                  <Swords className="h-5 w-5" aria-hidden="true" />{vi ? 'Tìm đối thủ ngay' : 'Find an opponent'}
                </button>
              </ModeCard>

              <ModeCard mode="PRIVATE" vi={vi} tag={vi ? 'Chơi cùng nhau' : 'Together'}
                text={vi ? 'Tạo phòng riêng rồi gửi mã 8 ký tự hoặc liên kết mời cho một người bạn.' : 'Create a private room and send the 8-character code or invite link to a friend.'}
                facts={[vi ? '2 người' : '2 players']}>
                <PaceSwitch vi={vi} value={roomPace} onChange={setRoomPace} />
                <button type="button" className={styles.ghost} disabled={disabled} onClick={() => send('create', { difficulty: roomPace })}>
                  <Plus className="h-4 w-4" aria-hidden="true" />{vi ? 'Tạo phòng mới' : 'Create a room'}
                </button>
                <form className={styles.joinRow} onSubmit={e => { e.preventDefault(); send('join', { roomCode: code }); }}>
                  <input className={styles.codeInput} maxLength={8} value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ''))}
                    aria-label={vi ? 'Mã phòng' : 'Room code'} placeholder={vi ? 'Mã phòng' : 'Room code'} autoComplete="off" spellCheck={false} />
                  <button type="submit" className={styles.cta} disabled={disabled || code.length !== 8}>{vi ? 'Vào phòng' : 'Join'}</button>
                </form>
              </ModeCard>
            </div>

            {archived ? (
              <section className={styles.panel} aria-labelledby="wc-archive">
                <div className={styles.panelHead}>
                  <h2 id="wc-archive" className={styles.panelTitle}><History className="h-5 w-5" aria-hidden="true" />
                    {t(vi, MODE_LABEL[archived.mode])} · {archived.chainLength} {vi ? 'mắt xích' : 'links'}</h2>
                  <button type="button" className={styles.ghost} onClick={() => setArchived(null)}><X className="h-4 w-4" aria-hidden="true" />{vi ? 'Đóng' : 'Close'}</button>
                </div>
                <Summary state={archived} vi={vi} />
              </section>
            ) : (
              <div className={styles.lower}>
                <section className={styles.panel} aria-labelledby="wc-record">
                  <div className={styles.panelHead}><h2 id="wc-record" className={styles.panelTitle}><Trophy className="h-5 w-5" aria-hidden="true" />{vi ? 'Thành tích của bạn' : 'Your record'}</h2></div>
                  {historyState === 'error' ? <p className={styles.muted}>{vi ? 'Chưa tải được lịch sử ván.' : 'History unavailable.'}</p> : (
                    <>
                      <div className={styles.stats}>
                        <div className={styles.stat}><div className={styles.statValue}>{historyState === 'loading' ? '…' : record.matches}</div><div className={styles.statLabel}>{vi ? 'Ván đã lưu' : 'Saved matches'}</div></div>
                        <div className={styles.stat}><div className={styles.statValue}>{historyState === 'loading' ? '…' : record.best}</div><div className={styles.statLabel}>{vi ? 'Nhiều từ nhất / ván' : 'Most words / match'}</div></div>
                        <div className={styles.stat}><div className={styles.statValue}>{historyState === 'loading' ? '…' : record.words}</div><div className={styles.statLabel}>{vi ? 'Từ đã nối' : 'Words played'}</div></div>
                      </div>
                      <p className={styles.muted} style={{ marginTop: '0.75rem' }}>{vi ? 'Tính trên tối đa 20 ván gần nhất của bạn.' : 'Counted over your latest 20 matches at most.'}</p>
                    </>
                  )}
                </section>

                <section className={styles.panel} aria-labelledby="wc-history">
                  <div className={styles.panelHead}><h2 id="wc-history" className={styles.panelTitle}><History className="h-5 w-5" aria-hidden="true" />{vi ? 'Ván gần đây' : 'Recent matches'}</h2></div>
                  {archiveError && <p className={styles.muted} role="alert">{t(vi, ERRORS.HISTORY)}</p>}
                  {historyState === 'loading' ? <p className={styles.muted}>{vi ? 'Đang tải…' : 'Loading…'}</p>
                    : historyState === 'error' ? <p className={styles.muted}>{vi ? 'Chưa tải được lịch sử ván.' : 'History unavailable.'}</p>
                    : history.length === 0 ? <p className={styles.muted}>{vi ? 'Chưa có ván đã lưu. Hãy bắt đầu chuỗi đầu tiên.' : 'No saved match yet. Start your first chain.'}</p>
                    : (
                      <div className={styles.historyList}>
                        {history.map(h => {
                          const Icon = MODE_ICON[h.mode as keyof typeof MODE_ICON] || Link2;
                          return (
                            <button key={h.matchId} type="button" className={styles.historyRow} data-tone={TONE[h.mode] || 'bot'} onClick={() => openArchive(h.matchId)}>
                              <span className={styles.historyIcon}><Icon className="h-4 w-4" aria-hidden="true" /></span>
                              <span className={styles.historyMain}>
                                <strong>{t(vi, MODE_LABEL[h.mode]) || h.mode}</strong>
                                <span>{new Date(h.finishedAt).toLocaleString(vi ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                              </span>
                              <span className={styles.historyCount}>{h.acceptedCount} {vi ? 'từ' : 'words'}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                </section>

                <section className={styles.panel} aria-labelledby="wc-rules">
                  <div className={styles.panelHead}><h2 id="wc-rules" className={styles.panelTitle}><ScrollText className="h-5 w-5" aria-hidden="true" />{vi ? 'Luật chơi' : 'Rules'}</h2></div>
                  <div className={styles.rules}>
                    <div className={styles.rule}><span className={styles.ruleNum}>1</span><div><strong>{vi ? 'Chữ cuối → chữ đầu' : 'Last letter → first letter'}</strong>
                      <p>{vi ? 'Từ đầu tiên bắt đầu bằng chữ máy chủ chọn ngẫu nhiên; từ sau bắt đầu bằng chữ cuối của từ trước.' : 'The first word starts with a random letter from the server; each next word starts with the previous word’s last letter.'}</p></div></div>
                    <div className={styles.rule}><span className={styles.ruleNum}>2</span><div><strong>{vi ? 'Từ tiếng Anh thật' : 'Real English words'}</strong>
                      <p>{vi ? 'Từ phải có trong từ điển. Không chấp nhận từ viết tắt, chữ viết tắt hay tên riêng.' : 'The word must be in the dictionary. Abbreviations, acronyms and proper names are refused.'}</p></div></div>
                    <div className={styles.rule}><span className={styles.ruleNum}>3</span><div><strong>{vi ? 'Không lặp từ của chính bạn' : 'Never repeat your own word'}</strong>
                      <p>{vi ? 'Mỗi người dùng một từ tối đa một lần trong ván; từ sai không làm mất lượt — gõ lại trong thời gian còn lại.' : 'Each player uses a word once per match; a refused word does not end your turn — retry while time remains.'}</p></div></div>
                    <div className={styles.rule}><span className={styles.ruleNum}>4</span><div><strong>{vi ? 'Hết giờ là kết thúc' : 'Time out ends it'}</strong>
                      <p>{vi ? '30 hoặc 45 giây mỗi lượt, +10 điểm mỗi từ. Khi đấu, ai hết giờ ở lượt mình thì thua; tối đa 200 lượt.' : '30 or 45 s per turn, +10 points per word. In a duel, whoever times out on their turn loses; 200 moves at most.'}</p></div></div>
                  </div>
                </section>
              </div>
            )}
            <p className={styles.muted} style={{ textAlign: 'center' }}>
              <BookOpen className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />
              {vi ? 'Nghĩa tiếng Việt lấy từ từ điển Anh–Việt tích hợp (CC BY-SA 4.0); không dùng AI trong trò chơi.' : 'Vietnamese meanings come from the built-in English–Vietnamese dictionary (CC BY-SA 4.0); no AI is used in the game.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function ModeCard({ mode, vi, tag, text, facts, children }: {
  mode: 'SOLO' | 'BOT' | 'QUICK' | 'PRIVATE'; vi: boolean; tag: string; text: string; facts: string[]; children: React.ReactNode;
}) {
  const Icon = MODE_ICON[mode];
  const id = `wc-mode-${mode.toLowerCase()}`;
  return (
    <section className={styles.modeCard} data-tone={TONE[mode]} aria-labelledby={id}>
      <div className={styles.modeArt}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={WORD_CHAIN_MODE_ART[mode]} alt="" aria-hidden="true" loading="lazy" width={840} height={588} />
        <span className={styles.modeTag}>{tag}</span>
      </div>
      <div className={styles.modeBody}>
        <h2 id={id} className={styles.modeTitle}><span className={styles.modeIcon}><Icon className="h-5 w-5" aria-hidden="true" /></span>{t(vi, MODE_LABEL[mode])}</h2>
        <p className={styles.modeText}>{text}</p>
        <div className={styles.modeFacts}>{facts.map(f => <span key={f} className={styles.fact}>{f}</span>)}</div>
        {children}
      </div>
    </section>
  );
}
