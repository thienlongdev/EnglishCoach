'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowLeft, HelpCircle, Lightbulb, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { hangmanApi, newHangmanRequestId } from '@/services/hangmanApi';
import type { HangmanBootstrap, HangmanDifficulty, HangmanRound } from '@/types/hangman';
import { HangmanScene } from './HangmanScene';
import { acceptsRound, playableEntry, entryDifficulty, hangmanLocation } from './hangmanPresentation';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ROWS = [LETTERS.slice(0,6), LETTERS.slice(6,12), LETTERS.slice(12,18), LETTERS.slice(18,24), LETTERS.slice(24)];
const difficultyCopy: Record<HangmanDifficulty, { vi: string; en: string; noteVi: string; noteEn: string }> = {
  EASY: { vi: 'Dễ', en: 'Easy', noteVi: '8 bóng bay · mở sẵn 2 chữ cái', noteEn: '8 balloons · 2 revealed letters' },
  MEDIUM: { vi: 'Vừa', en: 'Medium', noteVi: '7 bóng bay · mở sẵn 1 chữ cái', noteEn: '7 balloons · 1 revealed letter' },
  HARD: { vi: 'Khó', en: 'Hard', noteVi: '6 bóng bay · không mở sẵn chữ cái', noteEn: '6 balloons · no revealed letters' },
};
const categoryCopy: Record<string,{vi:string;en:string}> = { NATURE:{vi:'Thiên nhiên',en:'Nature'}, ANIMALS:{vi:'Động vật',en:'Animals'}, FOOD:{vi:'Ẩm thực',en:'Food'}, PLACES:{vi:'Địa điểm',en:'Places'}, EVERYDAY:{vi:'Đời sống',en:'Everyday'}, IDEAS:{vi:'Ý tưởng',en:'Ideas'}, VOCABULARY:{vi:'Từ vựng',en:'Vocabulary'} };
function exhausted(error: unknown) {
  return (error as { response?: { data?: { code?: string } } })?.response?.data?.code === 'WORD_POOL_EXHAUSTED';
}

function beep(muted: boolean, good: boolean) {
  if (muted || typeof window === 'undefined') return;
  try {
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = good ? 620 : 180;
    gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.07, context.currentTime + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.17); oscillator.onended = () => { void context.close(); };
  } catch { /* optional enhancement */ }
}

export function HangmanGame() {
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const searchParams = useSearchParams(), routeDifficulty = entryDifficulty(searchParams.get('difficulty')), playing = searchParams.get('view') === 'play';
  const [difficulty, setDifficulty] = useState<HangmanDifficulty>(routeDifficulty);
  const locationRef = useRef({ difficulty: routeDifficulty, playing, vi });
  locationRef.current = { difficulty: routeDifficulty, playing, vi };
  useEffect(() => { setDifficulty(routeDifficulty); }, [routeDifficulty]);
  const [bootstrap, setBootstrap] = useState<HangmanBootstrap | null>(null); const [round, setRound] = useState<HangmanRound | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [muted, setMuted] = useState(true); const [help, setHelp] = useState(false); const busy = useRef(false); const loadSeq = useRef(0); const trackSeq = useRef(0);
  useEffect(() => {
    // A direct play URL also has an entry predecessor. Native History integrates
    // with Next's search params; the marker survives refresh and browser Forward.
    if (playing && !window.history.state?.hangmanEntryBeforePlay) {
      window.history.replaceState(null, '', hangmanLocation(routeDifficulty));
      window.history.pushState({ hangmanEntryBeforePlay: true }, '', hangmanLocation(routeDifficulty, true));
    }
  }, [playing, routeDifficulty]);
  const backToEntry = () => { setHelp(false); window.history.back(); };
  const { data: session } = useSession();
  const accountScope = (session?.user as { id?: string } | undefined)?.id ?? session?.user?.email;
  const [pending, setPending] = useState<string | null>(null);
  const completed = bootstrap?.tracks.find(track => track.difficulty === difficulty)?.catalogCompleted ?? false;
  const [lossComplete, setLossComplete] = useState<string | null>(null);
  const roundRef = useRef(round); roundRef.current = round;
  const timingNode = useRef<HTMLElement>(null);
  const timing = useRef<{ input: number; dispatch: number; response?: number; feedback?: number; pop?: number } | null>(null);
  const publishTiming = useCallback(() => {
    const t = timing.current;
    if (!t) return;
    timingNode.current?.setAttribute('data-input-timing', JSON.stringify({
      feedbackMs: t.feedback === undefined ? null : +(t.feedback-t.input).toFixed(2),
      roundTripMs: t.response === undefined ? null : +(t.response-t.dispatch).toFixed(2),
      responseToPopMs: t.pop === undefined || t.response === undefined ? null : +(t.pop-t.response).toFixed(2),
      inputToPopMs: t.pop === undefined ? null : +(t.pop-t.input).toFixed(2),
    }));
  }, []);
  useLayoutEffect(() => {
    if (!pending || !timing.current) return;
    const generation = loadSeq.current;
    const frame = requestAnimationFrame(at => { if (generation === loadSeq.current && timing.current) { timing.current.feedback = at; publishTiming(); } });
    return () => cancelAnimationFrame(frame);
  }, [pending, publishTiming]);
  const refreshTrack = useCallback(async (nextDifficulty: HangmanDifficulty, data: HangmanBootstrap) => {
    const sequence = ++trackSeq.current;
    const selected = data.tracks.find(item => item.difficulty === nextDifficulty);
    if (!selected) throw new Error('Missing difficulty');
    // A lookup failure must not silently create a different playable state.
    const saved = selected.currentRoundId ? await hangmanApi.get(selected.currentRoundId) : null;
    if (sequence !== trackSeq.current) return;
    const entry = playableEntry(selected, saved);
    roundRef.current=entry.resume;setRound(entry.resume);
    setLossComplete(null);
  }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSeq.current;
    try { setLoading(true); setError(null); setRound(null); const data = await hangmanApi.bootstrap();
      if (sequence !== loadSeq.current) return;
      setBootstrap(data); if(locationRef.current.playing)await refreshTrack(locationRef.current.difficulty, data);
    } catch { if (sequence === loadSeq.current) setError(locationRef.current.vi ? 'Không thể tải trò chơi.' : 'Could not load Hangman.'); }
    finally { if (sequence === loadSeq.current) setLoading(false); }
  }, [refreshTrack, accountScope]);
  useEffect(() => { busy.current=false;setPending(null);roundRef.current=null;setRound(null);setBootstrap(null);setDifficulty(locationRef.current.difficulty);void load();return()=>{++loadSeq.current;++trackSeq.current;}; }, [load]);
  useEffect(() => {
    // Browser Forward/direct play may need a saved snapshot. Card selection has
    // no dependency here and never requests gameplay state.
    if(playing&&!loading&&bootstrap&&!busy.current&&roundRef.current?.difficulty!==routeDifficulty)void refreshTrack(routeDifficulty,bootstrap).catch(()=>setError(locationRef.current.vi?'Không thể tải trò chơi.':'Could not load Hangman.'));
  }, [playing,routeDifficulty,loading,bootstrap,refreshTrack]);
  useEffect(() => { try { setMuted(window.localStorage.getItem('hangman-muted') !== 'false'); } catch { /* storage can be unavailable */ } }, []);
  const applyRound = useCallback((next: HangmanRound, generation: number) => {
    if (!acceptsRound(roundRef.current, next, generation, loadSeq.current)) return;
    roundRef.current=next;setRound(next);
    if (next.status !== 'WON') return;
    void hangmanApi.bootstrap().then(data => { if (generation === loadSeq.current) setBootstrap(data); }).catch(() => { /* Saved result remains valid. */ });
  }, []);
  const chooseDifficulty = (next: HangmanDifficulty) => { if (busy.current) return; setDifficulty(next); };
  const start = async (level?: number) => {
    if (busy.current) return; busy.current=true;setPending('START');const generation=loadSeq.current;
    try { setError(null);
      let nextLevel=level;
      if(!playing){
        const data=await hangmanApi.bootstrap();if(generation!==loadSeq.current)return;
        const selected=data.tracks.find(track=>track.difficulty===difficulty);if(!selected)throw new Error('Missing difficulty');
        const saved=selected.currentRoundId?await hangmanApi.get(selected.currentRoundId):null;if(generation!==loadSeq.current)return;
        nextLevel=playableEntry(selected,saved).level;setBootstrap(data);
      }
      const next=await hangmanApi.start(difficulty,nextLevel);
      if(generation===loadSeq.current){roundRef.current=next;setRound(next);setLossComplete(null);if(!playing){window.history.replaceState(null,'',hangmanLocation(difficulty));window.history.pushState({hangmanEntryBeforePlay:true},'',hangmanLocation(difficulty,true));}beep(muted,true);}
    }
    catch (failure) { if(generation===loadSeq.current)setError(exhausted(failure)?(vi?'Chưa có từ mới phù hợp. Tiến độ của bạn đã được lưu.':'No alternative word is available. Your progress is saved.'):(vi?'Màn chơi này chưa mở.':'This level is not available.')); }
    finally { if(generation===loadSeq.current){busy.current=false;setPending(null);} }
  };
  const reloadCurrent = async (saved: HangmanRound, generation: number) => {
    try { applyRound(await hangmanApi.get(saved.roundId),generation); }
    catch { if(generation===loadSeq.current)setError(vi?'Không thể đồng bộ màn chơi.':'Could not sync this round.'); }
  };
  const usedLetters = round ? [...new Set([...round.correctLetters,...round.wrongLetters,...round.hintedLetters,...round.prefilledLetters])] : [];
  const guess = useCallback(async (raw: string) => {
    const letter=raw.toUpperCase(),saved=roundRef.current;
    if(!playing||!saved||busy.current||saved.status!=='ACTIVE'||[...saved.correctLetters,...saved.wrongLetters,...saved.hintedLetters,...saved.prefilledLetters].includes(letter))return;
    busy.current=true;setPending(letter);setError(null);const generation=loadSeq.current;
    timing.current={input:performance.now(),dispatch:performance.now()};
    try { const next=await hangmanApi.guess(saved,letter,newHangmanRequestId());
      if(generation!==loadSeq.current)return;
      if(timing.current)timing.current.response=performance.now();publishTiming();applyRound(next,generation);beep(muted,next.wrongLetters.length===saved.wrongLetters.length);
    } catch { if(generation===loadSeq.current){setError(vi?'Không lưu được lượt đoán. Đang đồng bộ lại…':'Guess could not be saved. Syncing…');await reloadCurrent(saved,generation);} }
    finally { if(generation===loadSeq.current){busy.current=false;setPending(null);} }
  }, [playing,muted,vi,applyRound,publishTiming]);
  const hint = async () => {
    const saved=roundRef.current;if(!saved||busy.current||saved.status!=='ACTIVE'||saved.hintsRemaining<1)return;
    busy.current=true;setPending('HINT');const generation=loadSeq.current;timing.current=null;
    try { applyRound(await hangmanApi.hint(saved,newHangmanRequestId()),generation);beep(muted,true); }
    catch { if(generation===loadSeq.current){setError(vi?'Gợi ý hiện không khả dụng.':'Hints are unavailable.');await reloadCurrent(saved,generation);} }
    finally { if(generation===loadSeq.current){busy.current=false;setPending(null);} }
  };
  const retry = async () => {
    const saved=roundRef.current;if(!saved||busy.current)return;busy.current=true;setPending('RETRY');const generation=loadSeq.current;
    try { const next=await hangmanApi.retry(saved.roundId);if(generation===loadSeq.current){roundRef.current=next;setRound(next);setLossComplete(null);setError(null);} }
    catch (failure) { if(generation===loadSeq.current)setError(exhausted(failure)?(vi?'Chưa có từ mới phù hợp. Tiến độ của bạn đã được lưu.':'No alternative word is available. Your progress is saved.'):(vi?'Không thể chơi lại.':'Retry failed.')); }
    finally { if(generation===loadSeq.current){busy.current=false;setPending(null);} }
  };
  useEffect(() => { if(!playing)return;const onKey = (event: KeyboardEvent) => { if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) return; if (/^[a-z]$/i.test(event.key)) { event.preventDefault(); void guess(event.key); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [playing,guess]);
  const visiblePattern = round?.status === 'LOST' && lossComplete !== round.roundId ? round.pattern.map(letter => letter && [...round.correctLetters, ...round.hintedLetters, ...round.prefilledLetters].includes(letter) ? letter : null) : round?.pattern;
  const categoryLabel = round ? (vi ? categoryCopy[round.category]?.vi : categoryCopy[round.category]?.en) ?? round.category : '';
  const patternLabel = visiblePattern?.map(letter => letter ?? 'blank').join(' ') ?? ''; const setSound = (value: boolean) => { setMuted(value); try { window.localStorage.setItem('hangman-muted', String(value)); } catch { /* best effort */ } };
  if (loading && playing) return <div className="mx-auto max-w-7xl p-6 text-on-surface" aria-busy="true">{vi ? 'Đang mở trò chơi…' : 'Opening game…'}</div>;
  return <main ref={timingNode} data-word-source={bootstrap?.wordSource} data-source-word-count={bootstrap?.sourceWordCount} data-eligible-word-counts={bootstrap ? JSON.stringify(Object.fromEntries(bootstrap.tracks.map(track => [track.difficulty, track.eligibleWordCount]))) : undefined} data-round-id={playing ? round?.roundId : undefined} data-round-version={playing ? round?.version : undefined} className="hm-page mx-auto w-full max-w-7xl space-y-5 p-3 text-on-surface sm:p-6 lg:p-8"><nav className="flex items-center justify-between">{playing ? <button type="button" onClick={backToEntry} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-on-surface-variant transition hover:bg-surface-container"><ArrowLeft className="h-4 w-4" />{vi ? 'Chọn độ khó' : 'Choose difficulty'}</button> : <Link href="/games" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-on-surface-variant transition hover:bg-surface-container"><ArrowLeft className="h-4 w-4" />{vi ? 'Thư viện trò chơi' : 'Games Library'}</Link>}<div className="flex gap-1"><button type="button" aria-label={vi ? 'Trợ giúp' : 'Help'} onClick={() => setHelp(value => !value)} className="rounded-xl p-2 transition hover:bg-surface-container"><HelpCircle className="h-5 w-5" /></button><button type="button" aria-label={muted ? (vi ? 'Bật âm thanh' : 'Unmute') : (vi ? 'Tắt âm thanh' : 'Mute')} onClick={() => setSound(!muted)} className="rounded-xl p-2 transition hover:bg-surface-container">{muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}</button></div></nav><header className="flex flex-wrap items-end justify-between gap-4 border-b border-outline-variant/50 pb-4"><div><h1 className="text-3xl font-black tracking-tight sm:text-4xl">Hangman <span className="ml-2 rounded-full bg-[#d8f1ef] px-3 py-1 align-middle text-xs font-black text-[#157b8b]">{vi ? 'Đoán từ' : 'Word rescue'}</span></h1></div>{playing && round && <div className="text-right text-sm"><div className="font-black">{vi ? 'Màn' : 'Level'} {round.levelNumber}</div><div className="text-on-surface-variant">{categoryLabel}</div></div>}</header>{help && <div role="dialog" className="rounded-2xl border border-[#99cfce] bg-[#effcf7] p-4 text-sm text-[#173b52]"><strong>{vi ? 'Cách chơi' : 'How to play'}</strong><p className="mt-1">{vi ? 'Đoán từng chữ cái A–Z. Mỗi chữ sai làm nổ một bóng bay; chữ đúng mở mọi vị trí. Bạn có hai gợi ý mỗi màn.' : 'Guess letters A–Z. Each new wrong letter pops one balloon; a correct letter reveals every occurrence. Two hints are available per round.'}</p></div>}{error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button type="button" onClick={() => void load()} className="font-black underline">{vi ? 'Thử lại' : 'Retry'}</button></div>}
    {!playing || !round ? <section data-guide="hm-lobby" className="hm-lobby overflow-clip rounded-[2rem] border border-[#9ed3d0] p-5 sm:p-8"><div className="relative z-10 mx-auto max-w-3xl text-center"><p className="text-sm font-black uppercase tracking-[.2em] text-[#157b8b]">{vi ? 'Giải cứu bóng bay · đoán chữ A–Z' : 'Balloon Rescue · A–Z adventure'}</p><h2 className="mt-2 text-3xl font-black text-[#123e56] sm:text-5xl">{vi ? 'Cứu nhà thám hiểm' : 'Rescue the adventurer'}</h2><p className="mx-auto mt-3 max-w-xl text-[#3f6470]">{vi ? 'Đoán từ tiếng Anh, giữ bóng bay trên mặt biển và vượt qua từng cấp độ.' : 'Guess the English word, keep the balloons afloat, and move through each level.'}</p><div data-guide="hm-levels" className="mx-auto mt-7 grid max-w-2xl grid-cols-3 gap-2 sm:gap-3">{(['EASY', 'MEDIUM', 'HARD'] as HangmanDifficulty[]).map(item => <button key={item} type="button" aria-pressed={difficulty === item} onClick={() => void chooseDifficulty(item)} className={`rounded-2xl border-2 bg-white/80 p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-4 ${difficulty === item ? 'border-[#157b8b] ring-2 ring-[#157b8b]/15' : 'border-transparent'}`}><span className="block text-lg font-black text-[#123e56]">{vi ? difficultyCopy[item].vi : difficultyCopy[item].en}</span><span className="mt-1 block text-xs font-semibold text-[#53717b]">{vi ? difficultyCopy[item].noteVi : difficultyCopy[item].noteEn}</span></button>)}</div><p className="mt-5 font-bold text-[#157b8b]" role="status">{completed ? (vi ? 'Bạn đã hoàn thành các màn. Tiếp tục luyện tập với từ mới!' : 'All levels completed. Keep practicing with fresh words!') : ''}</p><button data-guide="hm-play" type="button" disabled={loading || !!pending || !!error} onClick={() => void start()} className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-xl bg-[#123e56] px-7 py-3 font-black text-white shadow-lg shadow-[#123e56]/20 transition hover:-translate-y-0.5 hover:bg-[#185b72]"><Play className="h-5 w-5" />{pending === 'START' ? (vi ? 'Đang mở trò chơi…' : 'Opening game…') : (vi ? 'Chơi ngay' : 'Play Now')}</button></div><div className="hm-lobby-glow" aria-hidden="true" /></section> : <section className="space-y-5"><div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]"><div><HangmanScene key={round.roundId} round={round} pending={!!pending} onLossComplete={setLossComplete} onPopPaint={at => { if(timing.current){timing.current.pop=at;publishTiming();} }} /><div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-outline-variant/60 bg-surface-container-low px-4 py-3"><div><span className="text-xs font-black uppercase tracking-[.14em] text-on-surface-variant">{vi ? 'Bóng bay còn lại' : 'Balloons left'}</span><strong className="ml-2 text-lg text-[#157b8b]">{round.remainingBalloons}/{round.initialBalloons}</strong></div><button type="button" onClick={() => void hint()} disabled={!!pending || round.status !== 'ACTIVE' || round.hintsRemaining < 1} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#157b8b]/40 px-4 text-sm font-bold text-[#157b8b] transition hover:bg-[#d8f1ef] disabled:cursor-not-allowed disabled:opacity-50"><Lightbulb className="h-4 w-4" />{vi ? 'Gợi ý' : 'Hint'} ({round.hintsRemaining})</button></div></div><div className="rounded-[2rem] border border-[#9ed3d0] bg-[#fffdf4] p-4 shadow-[0_18px_40px_-30px_#17465d] sm:p-6"><div className="text-center"><p className="text-xs font-black uppercase tracking-[.2em] text-[#157b8b]">{categoryLabel}</p><div aria-label={patternLabel} className="hm-word-slots mt-5 flex min-h-14 flex-wrap justify-center gap-2">{visiblePattern?.map((letter, index) => <span key={`${index}-${letter}`} className={`hm-word-slot flex h-11 min-w-8 items-center justify-center border-b-4 px-1 text-2xl font-black sm:h-14 sm:min-w-10 sm:text-3xl ${letter ? 'border-[#157b8b] text-[#173b52]' : 'border-[#173b52] text-transparent'}`}>{letter ?? '·'}</span>)}</div><p className="mt-4 text-sm font-semibold text-[#536975]" aria-live="polite">{round.status === 'ACTIVE' ? (vi ? 'Chọn một chữ cái' : 'Choose a letter') : (round.status === 'WON' ? (vi ? 'Bạn đã cứu được bóng bay!' : 'You saved the balloons!') : (lossComplete === round.roundId ? (vi ? 'Bóng bay đã hết.' : 'The balloons are gone.') : (vi ? 'Cẩn thận! Cá mập đang đến…' : 'Look out! Here comes the shark…')))}</p></div><fieldset className="mt-6"><legend className="sr-only">{vi ? 'Bảng chữ cái' : 'Alphabet board'}</legend><div className="space-y-2">{ROWS.map((row, rowIndex) => <div key={rowIndex} className="flex justify-center gap-1.5 sm:gap-2">{row.map(letter => { const used = usedLetters.includes(letter); const prefilled = round.prefilledLetters.includes(letter); const hinted = round.hintedLetters.includes(letter); const correct = round.correctLetters.includes(letter); const wrong = round.wrongLetters.includes(letter); return <button key={letter} type="button" aria-label={`${letter}${used ? ' used' : ''}`} aria-pressed={used} aria-busy={pending === letter} disabled={!!pending || round.status !== 'ACTIVE' || used} onClick={() => void guess(letter)} className={`hm-key h-10 w-9 rounded-lg border-2 text-lg font-black transition sm:h-11 sm:w-11 ${pending === letter ? 'hm-key-pending' : prefilled ? 'hm-key-prefilled' : hinted ? 'hm-key-hinted' : correct ? 'hm-key-correct' : wrong ? 'hm-key-wrong' : 'border-[#173b52] bg-[#fffdf4] text-[#173b52] hover:-translate-y-0.5 hover:bg-[#d8f1ef]'} disabled:cursor-not-allowed disabled:opacity-70`}>{letter}</button>; })}</div>)}</div></fieldset><p className="mt-4 text-center text-xs text-[#536975]">{vi ? 'Bàn phím máy tính cũng hoạt động.' : 'Your physical keyboard works too.'}</p></div></div>{(round.status === 'WON' || (round.status === 'LOST' && lossComplete === round.roundId)) && <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-outline-variant/60 bg-surface-container-low p-4"><div className="mr-3 text-center"><p className="text-xs font-black uppercase tracking-[.16em]">{round.status === 'WON' ? (vi ? 'Điểm' : 'Score') : (vi ? 'Đáp án' : 'Answer')}</p><p className="text-xl font-black text-[#157b8b]">{round.status === 'WON' ? round.score : round.answer}</p></div><button type="button" onClick={() => void retry()} disabled={!!pending} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#123e56] px-4 font-bold text-white"><RotateCcw className="h-4 w-4" />{vi ? 'Chơi lại' : 'Retry'}</button>{round.nextLevelAvailable && <button type="button" onClick={() => void start(round.levelNumber + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#157b8b]/40 px-4 font-bold text-[#157b8b]"><Play className="h-4 w-4" />{vi ? 'Màn tiếp' : 'Next level'}</button>}</div>}</section>}
  </main>;
}
