'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, DoorOpen, Link2, LogOut, RotateCcw, Send, Trophy } from 'lucide-react';
import { ENDS, ERRORS, LEVEL_LABEL, MODE_LABEL, WORD_ERRORS, t } from './copy';
import { Avatar, LetterOrb, Linked, WordCard } from './WordChainParts';
import { WORD_CHAIN_ART } from './wordChainArt';
import type { ChainPlayer, ChainState } from './types';
import styles from './wordChain.module.css';

type Props = {
  state: ChainState; vi: boolean; connected: boolean; pending: boolean; error: string | null; errorId: number;
  seconds: number; send: (action: string, payload?: Record<string, unknown>) => boolean;
};

const TONE: Record<ChainState['mode'], string> = { SOLO: 'solo', BOT: 'bot', QUICK: 'quick', PRIVATE: 'private' };

export function WordChainArena(props: Props) {
  const { state, vi, connected, pending, send } = props;
  const you = state.players.find(p => p.id === state.youId);
  const subtitle = state.mode === 'BOT'
    ? `${t(vi, LEVEL_LABEL[state.botLevel || 'MEDIUM'])} · ${state.turnSeconds ?? 30}s ${vi ? 'mỗi lượt' : 'per turn'}`
    : `${state.turnSeconds ?? 30}s ${vi ? 'mỗi lượt' : 'per turn'}`;
  return (
    <section className={styles.arena} data-tone={TONE[state.mode]} aria-label={vi ? 'Ván Nối từ' : 'Word Chain match'}>
      <div className={styles.arenaBar}>
        <div className={styles.arenaTitle}>
          <span className={styles.modeIcon}><Link2 className="h-5 w-5" aria-hidden="true" /></span>
          <div><strong>{t(vi, MODE_LABEL[state.mode])}</strong><span>{subtitle}</span></div>
        </div>
        {(state.mode === 'PRIVATE' || state.mode === 'QUICK') && (
          <span className={styles.roomCode}>{vi ? 'Phòng' : 'Room'} <b>{state.roomCode}</b></span>
        )}
        <span className={styles.pill} role="status">
          <span className={styles.dot} data-on={connected} />
          {connected ? (vi ? 'Đã kết nối' : 'Connected') : (vi ? 'Đang kết nối lại…' : 'Reconnecting…')}
        </span>
        {state.status === 'ACTIVE' && (
          <button type="button" className={styles.pill} disabled={!connected || pending} onClick={() => send('give-up')}>
            <LogOut className="h-4 w-4" aria-hidden="true" />{state.mode === 'SOLO' ? (vi ? 'Dừng ván' : 'Stop match') : (vi ? 'Bỏ cuộc' : 'Give up')}
          </button>
        )}
      </div>

      <Players state={state} vi={vi} />

      {state.status === 'WAITING' && <Waiting {...props} youReady={!!you?.ready} />}
      {state.status === 'ACTIVE' && <Live {...props} />}
      {state.status === 'FINISHED' && <Results {...props} />}
    </section>
  );
}

function Players({ state, vi }: { state: ChainState; vi: boolean }) {
  return (
    <div className={styles.players}>
      {state.players.map(p => {
        const turn = state.status === 'ACTIVE' && state.turnPlayerId === p.id;
        const isYou = p.id === state.youId;
        return (
          <div key={p.id} className={styles.player} data-turn={turn} aria-current={turn ? 'true' : undefined}>
            <Avatar player={p} />
            <div className={styles.playerMain}>
              <span className={styles.playerName}>
                <span>{p.bot ? 'Echo' : p.name}</span>
                {isYou && <span className={styles.youBadge}>{vi ? 'Bạn' : 'You'}</span>}
              </span>
              {turn
                ? <span className={styles.turnTag}>{vi ? 'Đang đến lượt' : 'On turn'}</span>
                : <span className={styles.presence}>
                    <span className={styles.dot} data-on={p.connected} />
                    {p.bot ? (vi ? 'Trợ lý Echo' : 'Echo assistant')
                      : !p.connected ? (vi ? 'Mất kết nối · chờ 15 giây' : 'Disconnected · 15 s grace')
                      : state.status === 'WAITING' ? (p.ready ? (vi ? 'Đã sẵn sàng' : 'Ready') : (vi ? 'Chưa sẵn sàng' : 'Not ready'))
                      : (vi ? 'Trực tuyến' : 'Online')}
                  </span>}
            </div>
            <div className={styles.playerScore}>{p.score}<small>{vi ? 'điểm' : 'pts'}</small></div>
          </div>
        );
      })}
    </div>
  );
}

function Waiting({ state, vi, connected, pending, send, youReady }: Props & { youReady: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      const url = new URL('/games/word-chain', window.location.origin);
      url.searchParams.set('invite', state.roomCode);
      await navigator.clipboard.writeText(url.toString());
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    } catch { setCopied(false); }
  };
  const alone = state.players.length < 2;
  const slots: (ChainPlayer | undefined)[] = [state.players[0], state.players[1]];
  return (
    <div className={styles.waiting}>
      <h2>
        {alone
          ? state.mode === 'QUICK' ? (vi ? 'Đang tìm đối thủ trực tuyến' : 'Looking for an online opponent') : (vi ? 'Mời một người bạn vào phòng' : 'Invite a friend to this room')
          : (vi ? 'Hai người đã vào phòng — bấm Sẵn sàng' : 'Both players are here — press Ready')}
      </h2>
      {state.mode === 'PRIVATE' && alone && (
        <>
          <div className={styles.codeBig} aria-label={`${vi ? 'Mã phòng' : 'Room code'} ${state.roomCode}`}>
            {state.roomCode.split('').map((c, i) => <span key={i} aria-hidden="true">{c}</span>)}
          </div>
          <button type="button" className={styles.ghost} onClick={() => void copy()}>
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied ? (vi ? 'Đã sao chép liên kết mời' : 'Invite link copied') : (vi ? 'Sao chép liên kết mời' : 'Copy invite link')}
          </button>
        </>
      )}
      <div className={styles.slots}>
        {slots.map((p, i) => (
          <div key={i} className={styles.slot} data-filled={!!p}>
            <Avatar player={p} />
            <span className={styles.slotName}>{p ? (p.id === state.youId ? (vi ? 'Bạn' : 'You') : p.name) : (vi ? 'Đang chờ…' : 'Waiting…')}</span>
            {p ? <span className={styles.slotState} data-ready={p.ready}>{p.ready ? (vi ? 'Sẵn sàng' : 'Ready') : (vi ? 'Chưa sẵn sàng' : 'Not ready')}</span>
              : <span className={styles.waitDots} aria-hidden="true"><i /><i /><i /></span>}
          </div>
        ))}
      </div>
      <p className={styles.muted}>
        {vi ? `Ván bắt đầu khi cả hai bấm Sẵn sàng. Mỗi lượt có ${state.turnSeconds ?? 30} giây; chữ cái mở đầu do máy chủ chọn ngẫu nhiên.`
          : `The match starts when both press Ready. Each turn has ${state.turnSeconds ?? 30} seconds; the server picks a random starting letter.`}
      </p>
      <div className={styles.row}>
        <button type="button" className={styles.cta} disabled={!connected || pending || youReady || alone} onClick={() => send('ready')}>
          <Check className="h-5 w-5" aria-hidden="true" />{youReady ? (vi ? 'Đã sẵn sàng' : 'Ready') : (vi ? 'Sẵn sàng' : 'Ready')}
        </button>
        <button type="button" className={styles.ghost} disabled={!connected || pending} onClick={() => send('leave')}>
          <DoorOpen className="h-4 w-4" aria-hidden="true" />{vi ? 'Rời phòng' : 'Leave'}
        </button>
      </div>
    </div>
  );
}

function Live({ state, vi, connected, pending, error, errorId, seconds, send }: Props) {
  const [word, setWord] = useState('');
  const [sentWord, setSentWord] = useState('');
  const [dismissed, setDismissed] = useState(-1);
  const [praise, setPraise] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<number>(state.moves.at(-1)?.moveId ?? 0);
  const firstRender = useRef(true);
  const mine = useRef(state.acceptedCount);
  const match = useRef(state.matchId);
  const myTurn = state.turnPlayerId === state.youId;
  const letter = state.requiredLetter || '';
  const lastMove = state.moves.at(-1);

  // Follow the newest link inside the chain panel only (never scroll the page away from the composer).
  useLayoutEffect(() => {
    const panel = scroller.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [state.matchId, state.moves.length, lastMove?.moveId]);
  useEffect(() => { firstRender.current = false; seen.current = lastMove?.moveId ?? 0; }, [lastMove?.moveId]);

  useEffect(() => {
    if (match.current !== state.matchId) { match.current = state.matchId; mine.current = 0; setWord(''); }
    if (state.acceptedCount > mine.current) {
      const own = [...state.moves].reverse().find(m => m.playerId === state.youId);
      setWord('');
      if (own) setPraise(own.word.displayWord);
    }
    mine.current = state.acceptedCount;
  }, [state.matchId, state.acceptedCount, state.moves, state.youId]);
  useEffect(() => { if (!praise) return; const id = setTimeout(() => setPraise(null), 2200); return () => clearTimeout(id); }, [praise]);
  useEffect(() => { if (myTurn) input.current?.focus({ preventScroll: true }); }, [myTurn, state.revision]);

  const wordError = error && WORD_ERRORS.has(error) && dismissed !== errorId ? error : null;
  const errorText = wordError === 'WRONG_LETTER' ? (vi ? `Từ phải bắt đầu bằng chữ “${letter.toUpperCase()}”.` : `The word must start with “${letter.toUpperCase()}”.`)
    : wordError === 'SELF_DUPLICATE' ? (vi ? `Bạn đã dùng “${sentWord}” trong ván này. Chọn từ khác.` : `You already played “${sentWord}” in this match.`)
    : wordError ? t(vi, ERRORS[wordError]) : null;
  const canType = myTurn && connected && seconds > 0;
  const submit = () => {
    const value = word.trim();
    if (!canType || !value || pending) return;
    if (send('submit', { word: value })) { setSentWord(value.toLowerCase()); setDismissed(-1); }
  };
  const solo = state.mode === 'SOLO';
  const side = (index: number, playerId: number) => solo ? (index % 2 ? 'right' : 'left') : playerId === state.youId ? 'right' : 'left';
  const turnPlayer = state.players.find(p => p.id === state.turnPlayerId);
  const turnText = myTurn ? (vi ? 'Lượt của bạn' : 'Your turn')
    : turnPlayer?.bot ? (vi ? 'Echo đang chọn từ…' : 'Echo is choosing a word…')
    : (vi ? `Lượt của ${turnPlayer?.name ?? 'đối thủ'}` : `${turnPlayer?.name ?? 'Opponent'}’s turn`);

  return (
    <>
      <div className={styles.stage}>
        <div className={styles.chainPanel}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.chainArt} src={WORD_CHAIN_ART.arena} alt="" aria-hidden="true" />
          <span className={styles.chainVeil} aria-hidden="true" />
          <div className={styles.chainHead}>
            <span>{vi ? 'Chuỗi từ' : 'The chain'} · {state.chainLength} {vi ? 'mắt xích' : 'links'}</span>
            <span>{vi ? 'Bắt đầu' : 'Started on'} <b>{(state.startLetter || letter).toUpperCase()}</b></span>
          </div>
          <div ref={scroller} className={styles.chainScroll} data-testid="word-chain-history" aria-live="polite" aria-relevant="additions">
            {state.moves.length === 0 ? (
              <div className={styles.chainEmpty}>
                <b aria-hidden="true">{letter.toUpperCase()}</b>
                <span>{myTurn ? (vi ? `Mở đầu chuỗi bằng một từ tiếng Anh bắt đầu bằng chữ “${letter.toUpperCase()}”.` : `Open the chain with an English word starting with “${letter.toUpperCase()}”.`)
                  : (vi ? 'Chuỗi sẽ hiện ở đây khi từ đầu tiên được chấp nhận.' : 'The chain appears here once the first word is accepted.')}</span>
              </div>
            ) : state.moves.map((m, i) => {
              const owner = state.players.find(p => p.id === m.playerId);
              const s = side(i, m.playerId);
              const isYou = m.playerId === state.youId;
              return (
                <div key={m.moveId}>
                  {i > 0 && <div className={styles.link} aria-hidden="true" />}
                  <div className={styles.move} data-side={s}>
                    <span className={styles.moveAvatar}><Avatar player={owner} small /></span>
                    <div>
                      <div className={styles.moveBy}>
                        <span className={styles.joint} aria-label={vi ? `Mắt xích ${m.moveId}` : `Link ${m.moveId}`}>{m.moveId}</span>
                        {isYou ? (vi ? 'Bạn' : 'You') : owner?.bot ? 'Echo' : owner?.name}
                      </div>
                      <WordCard word={m.word} vi={vi} mine={isYou && !solo} fresh={!firstRender.current && m.moveId > seen.current} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className={styles.focus} aria-labelledby="wc-required">
          <span className={styles.turnLine} data-mine={myTurn} role="status">{turnText}</span>
          <h2 id="wc-required" className={styles.srOnly}>{vi ? `Chữ cần nối: ${letter.toUpperCase()}` : `Required letter: ${letter.toUpperCase()}`}</h2>
          <LetterOrb letter={letter} seconds={seconds} total={state.turnSeconds ?? 30} />
          <p className={styles.srOnly} aria-live="off">{seconds} {vi ? 'giây còn lại' : 'seconds left'}</p>
          <p className={styles.prevWord}>
            {state.currentWord
              ? <>{vi ? 'Từ trước: ' : 'Previous word: '}<b lang="en"><Linked word={state.currentWord.displayWord} /></b></>
              : (vi ? 'Chữ mở đầu do máy chủ chọn ngẫu nhiên' : 'Random starting letter from the server')}
          </p>
          <div className={styles.focusStats}>
            <div><b>{state.acceptedCount}</b><span>{vi ? 'Từ của bạn' : 'Your words'}</span></div>
            <div><b>{state.chainLength}</b><span>{vi ? 'Độ dài chuỗi' : 'Chain'}</span></div>
            <div><b>{state.rejectedCount}</b><span>{vi ? 'Lần chưa hợp lệ' : 'Rejected'}</span></div>
          </div>
          <p className={styles.hint}>{vi ? 'Từ tiếng Anh có trong từ điển · không viết tắt, không tên riêng · không lặp từ của chính bạn.'
            : 'An English dictionary word · no abbreviations or proper names · never repeat your own word.'}</p>
        </aside>
      </div>

      <div className={styles.dockWrap}>
        {errorText && <p className={styles.feedback} data-kind="bad" role="alert">{errorText}</p>}
        {!errorText && praise && <p className={styles.feedback} data-kind="good" role="status">+10 · {praise}</p>}
        <form className={styles.dock} data-live={canType} onSubmit={e => { e.preventDefault(); submit(); }}>
          <span className={styles.dockLetter} aria-hidden="true">{letter.toUpperCase()}</span>
          <label className={styles.srOnly} htmlFor="chain-word">{vi ? 'Từ tiếp theo' : 'Next word'}</label>
          <input
            ref={input} id="chain-word" className={styles.dockInput} value={word} lang="en"
            onChange={e => { setWord(e.target.value); if (wordError) setDismissed(errorId); }}
            placeholder={canType ? (vi ? `Nhập từ bắt đầu bằng ${letter.toUpperCase()}…` : `A word starting with ${letter.toUpperCase()}…`) : turnText}
            maxLength={40} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="send"
            disabled={!myTurn} readOnly={pending} aria-invalid={!!wordError}
          />
          <button type="submit" className={`${styles.cta} ${styles.dockSend}`} disabled={!canType || pending || !word.trim()}>
            <Send className="h-5 w-5" aria-hidden="true" />
            <span className={styles.sendLabel}>{pending ? (vi ? 'Đang gửi…' : 'Sending…') : (vi ? 'Nối từ' : 'Connect')}</span>
            <kbd>Enter</kbd>
          </button>
        </form>
      </div>
    </>
  );
}

function Results({ state, vi, connected, pending, send }: Props) {
  const solo = state.mode === 'SOLO';
  const youWin = state.winnerId === state.youId;
  const title = solo ? (vi ? 'Chuỗi của bạn đã hoàn thành' : 'Your chain is complete')
    : state.winnerId == null ? (vi ? 'Hòa' : 'Draw')
    : youWin ? (vi ? 'Bạn thắng!' : 'You win!') : (vi ? 'Đối thủ thắng ván này' : 'Your opponent won this one');
  const youVoted = !!state.players.find(p => p.id === state.youId)?.rematch;
  const otherVoted = state.players.some(p => p.id !== state.youId && !p.bot && p.rematch);
  return (
    <div className={styles.results}>
      <div className={styles.banner}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.heroArt} src={WORD_CHAIN_ART.hero} alt="" aria-hidden="true" />
        <span className={styles.heroScrim} aria-hidden="true" />
        <Trophy className="h-9 w-9" aria-hidden="true" />
        <h2>{title}</h2>
        <p>{t(vi, ENDS[state.endReason || ''])} · {state.resultSaved ? (vi ? 'Đã lưu vào lịch sử' : 'Saved to your history') : (vi ? 'Đang lưu kết quả…' : 'Saving the result…')}</p>
        {!solo && (
          <div className={styles.scoreRow}>
            {state.players.map(p => (
              <div key={p.id} className={styles.scoreCard} data-win={state.winnerId === p.id}>
                <Avatar player={p} small />
                <div><b>{p.score}</b> <span>{p.id === state.youId ? (vi ? 'Bạn' : 'You') : p.bot ? 'Echo' : p.name}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Summary state={state} vi={vi} />
      <div className={styles.actions}>
        <button type="button" className={styles.cta} disabled={!connected || pending || !state.resultSaved || youVoted} onClick={() => send('rematch')}>
          <RotateCcw className="h-5 w-5" aria-hidden="true" />{solo ? (vi ? 'Chơi lại' : 'Play again') : (vi ? 'Đấu lại' : 'Rematch')}
        </button>
        <button type="button" className={styles.ghost} disabled={!connected || pending} onClick={() => send('leave')}>
          {vi ? 'Về sảnh Nối từ' : 'Back to the lobby'}
        </button>
        <Link href="/games" className={styles.ghost}>{vi ? 'Thư viện trò chơi' : 'Games library'}</Link>
      </div>
      {(youVoted || otherVoted) && !solo && state.mode !== 'BOT' && (
        <p className={styles.muted} role="status">
          {youVoted ? (vi ? 'Đang chờ đối thủ đồng ý đấu lại…' : 'Waiting for your opponent to accept…') : (vi ? 'Đối thủ muốn đấu lại.' : 'Your opponent wants a rematch.')}
        </p>
      )}
    </div>
  );
}

/** A finished match from its own snapshot: tracked numbers only, then every word of the chain to review. */
export function Summary({ state, vi }: { state: ChainState; vi: boolean }) {
  const stats: [string, string | number][] = [
    [vi ? 'Từ của bạn' : 'Your words', state.acceptedCount],
    [vi ? 'Độ dài chuỗi' : 'Chain length', state.chainLength],
    [vi ? 'Lần chưa hợp lệ' : 'Rejected tries', state.rejectedCount],
    [vi ? 'Phản hồi trung bình' : 'Average response', state.averageResponseMs == null ? '—' : `${(state.averageResponseMs / 1000).toFixed(1)} s`],
  ];
  return (
    <div className={styles.review}>
      <div className={styles.stats} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
        {stats.map(([label, value]) => <div key={label} className={styles.stat}><div className={styles.statValue}>{value}</div><div className={styles.statLabel}>{label}</div></div>)}
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHead}><h3 className={styles.panelTitle}>{vi ? 'Ôn lại từ vựng của ván' : 'Review the words of this match'}</h3></div>
        {state.moves.length ? (
          <div className={styles.reviewGrid}>
            {state.moves.map(m => (
              <div key={m.moveId}>
                <span className={styles.reviewNum}>#{m.moveId} · {m.playerId === state.youId ? (vi ? 'Bạn' : 'You') : m.playerId === 0 ? 'Echo' : state.players.find(p => p.id === m.playerId)?.name}</span>
                <WordCard word={m.word} vi={vi} />
              </div>
            ))}
          </div>
        ) : <p className={styles.muted}>{vi ? 'Ván này chưa có từ nào được chấp nhận.' : 'No word was accepted in this match.'}</p>}
      </div>
    </div>
  );
}
