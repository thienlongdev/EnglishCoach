'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Gamepad2, Orbit, Lamp, Users, Trophy, Volume2, RotateCcw } from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { DiveLink, DiveDestination } from './DiveLink';
import styles from './dive.module.css';

/**
 * The five depths of the dive. Every demonstration is a small, local, deterministic example written for this page
 * (labelled as an example); none of them calls an API, an AI model or the microphone. What they show is what the
 * product really does: the flashcard answers and their schedule, sentence dictation, meaning in context, a suggested
 * rewrite, the learning path's stations and the worlds around the lessons.
 */

function SceneHead({ id, depth, title, children }: { id: string; depth: string; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <p className={`${styles.depth} ${styles.rise}`}>{depth}</p>
      <h3 id={`${id}-title`} className={`${styles.title} ${styles.rise}`} style={{ '--lag': 0.05 } as React.CSSProperties}>
        {title}
      </h3>
      <div className={`space-y-5 ${styles.rise}`} style={{ '--lag': 0.12 } as React.CSSProperties}>
        {children}
      </div>
    </div>
  );
}

/**
 * Where Echo swims at this depth: the band of open water above the scene (the seam with the depth before it), so
 * Echo leads the way down between scenes and never crosses the text or an instrument. Wide screens only; on phones
 * Echo keeps to the hero and the final invitation, as before.
 */
function EchoLane({ id, say }: { id: string; say: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-[8%] top-0 h-[24vh] -translate-y-1/2"
      data-whale-lane={id}
      data-whale-path="hover"
      data-whale-size="170,0,0"
      data-whale-amp="0.3"
      data-whale-period="17"
      data-whale-haze="0.06"
      data-whale-min="1024"
      data-whale-say={say}
    />
  );
}

// ───────────────────────────── 1 · A word becomes a memory ─────────────────────────────

const RATINGS = [
  { tone: 'hard', label: 'Khó', stop: 0, result: 'Từ này quay lại ngay trong hôm nay, cho đến khi bạn nhớ được.' },
  { tone: 'good', label: 'Tốt', stop: 1, result: 'Hẹn gặp lại từ này sau 3 ngày, đúng lúc trí nhớ bắt đầu phai.' },
  { tone: 'easy', label: 'Dễ', stop: 2, result: 'Từ này được ghi là đã thuộc và rời khỏi hàng chờ ôn.' },
] as const;

export function MemoryScene() {
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [rated, setRated] = useState<number | null>(null);
  const reset = () => {
    setFace('front');
    setRated(null);
  };

  return (
    <section id="tu-vung" data-dive-scene data-dive-track className={styles.scene} aria-labelledby="tu-vung-title">
      <EchoLane id="tu-vung" say="Từ nào khó, mình đưa nó quay lại sớm hơn." />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
        <SceneHead id="tu-vung" depth="Tầng 1 · Từ vựng" title="Một từ mới trở thành ký ức">
          <p className={styles.lead}>
            Lật thẻ, tự hỏi mình còn nhớ không, rồi trả lời thật lòng. Chính câu trả lời ấy quyết định khi nào từ này quay lại với bạn.
          </p>
          <ul className={styles.points}>
            <li>Bộ từ theo chủ đề đời sống, bộ từ IELTS và bộ từ của riêng bạn</li>
            <li>Lưu từ mới ngay lúc đang đọc, đang nghe hay đang tra từ điển</li>
            <li>Muốn thử thách hơn: tự gõ nghĩa hoặc điền từ thay vì chỉ lật thẻ</li>
          </ul>
          <DiveLink to="/flashcards">Vào học từ vựng</DiveLink>
        </SceneHead>

        <div className={`mx-auto w-full max-w-sm ${styles.rise}`} style={{ '--lag': 0.08 } as React.CSSProperties} data-no-ripple>
          <div className={styles.cardStage}>
            <div aria-hidden="true" className="pointer-events-none absolute -inset-[16%]" data-ocean-form="ring" data-ocean-tint="pearl" />
            <div className={styles.cardTilt}>
              <div className={styles.card} data-face={face}>
                <button
                  type="button"
                  className={`${styles.pearl} ${styles.face} cursor-pointer`}
                  onClick={() => setFace('back')}
                  inert={face === 'back'}
                >
                  <span className={`${styles.chip} self-start`}>Thẻ từ · Ví dụ minh họa</span>
                  <span className="mt-auto block">
                    <span className={`${styles.word} block`}>resilient</span>
                    <span className="mt-2 block font-mono text-sm text-[#3b5387]">/rɪˈzɪliənt/ · adjective</span>
                  </span>
                  <span className="mt-auto flex items-center gap-2 text-sm font-bold text-[#2f5fe0]">
                    <RotateCcw aria-hidden="true" className="h-4 w-4" /> Chạm để lật thẻ
                  </span>
                </button>

                <div className={`${styles.pearl} ${styles.face} ${styles.faceBack}`} inert={face === 'front'}>
                  <span className={`${styles.chip} self-start`}>Bạn nhớ từ này đến đâu?</span>
                  <div className="mt-4 space-y-2">
                    <p className="text-2xl font-bold text-[#0b2457]">kiên cường, mau hồi phục</p>
                    <p className="text-sm italic leading-relaxed text-[#3b5387]">
                      &ldquo;Children are often more resilient than adults expect.&rdquo;
                    </p>
                  </div>
                  <div className="mt-auto space-y-3">
                    <div className="flex gap-2" role="group" aria-label="Mức độ nhớ">
                      {RATINGS.map((rating, index) => (
                        <button
                          key={rating.tone}
                          type="button"
                          className={`${styles.rate} cursor-pointer`}
                          data-tone={rating.tone}
                          aria-pressed={rated === index}
                          onClick={() => setRated(index)}
                        >
                          {rating.label}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={reset} className="cursor-pointer text-xs font-bold text-[#2f5fe0] underline underline-offset-4">
                      Lật lại mặt trước
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-9">
            <div className={styles.tide}>
              <i aria-hidden="true" className={styles.tidePearl} data-stop={rated === null ? undefined : RATINGS[rated].stop} />
              <span data-on={rated === 0 ? 1 : undefined}>Hôm nay</span>
              <span data-on={rated === 1 ? 1 : undefined}>Sau 3 ngày</span>
              <span data-on={rated === 2 ? 1 : undefined}>Đã thuộc</span>
            </div>
            <p className="mt-4 min-h-[2.6rem] text-center text-sm font-semibold text-white" aria-live="polite">
              {rated === null ? 'Lật thẻ rồi chọn Khó, Tốt hoặc Dễ để xem từ này đi đâu.' : RATINGS[rated].result}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────── 2 · Sound becomes speech ─────────────────────────────

const BAR_COUNT = 56;
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => (0.22 + 0.78 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37 + 1))).toFixed(3));
const HEARD = ['The', 'tide', 'comes', 'in', 'twice', 'a', 'day.'];
const DICTATION = { before: 'She speaks slowly and', answer: 'clearly', full: 'She speaks slowly and clearly.' };
const PHONEMES = [
  { ipa: 'θ', tip: 'Đặt nhẹ đầu lưỡi giữa hai hàm răng rồi thổi hơi ra, dây thanh không rung.' },
  { ipa: 'ɪ', tip: 'Âm “i” ngắn và thả lỏng, miệng mở hẹp, không kéo dài như “ee”.' },
  { ipa: 'ŋ', tip: 'Lưng lưỡi chạm ngạc mềm, hơi đi lên mũi, giống âm cuối của “sing”.' },
  { ipa: 'k', tip: 'Chặn hơi ở cuối lưỡi rồi bật ra thật gọn để kết thúc từ.' },
];

export function SoundScene() {
  const [canSpeak, setCanSpeak] = useState(false);
  const [typed, setTyped] = useState('');
  const [check, setCheck] = useState<'idle' | 'right' | 'wrong' | 'shown'>('idle');
  const [phoneme, setPhoneme] = useState(0);
  const inputId = useId();

  useEffect(() => {
    setCanSpeak(typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined');
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);

  // Sound only ever starts from this button: the browser's own voice, no request, no recording.
  const speak = () => {
    const utterance = new SpeechSynthesisUtterance(DICTATION.full);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const answer = typed.trim().toLowerCase().replace(/[.,!?]/g, '');
    if (!answer) return;
    setCheck(answer === DICTATION.answer ? 'right' : 'wrong');
  };

  return (
    <section id="nghe-noi" data-dive-scene data-dive-track className={styles.scene} aria-labelledby="nghe-noi-title">
      <EchoLane id="nghe-noi" say="Nghe kỹ nhé, rồi nói theo mình!" />
      <div className="mx-auto max-w-6xl space-y-14 px-5 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <SceneHead id="nghe-noi" depth="Tầng 2 · Nghe và nói" title="Âm thanh hóa thành lời">
            <p className={styles.lead}>
              Lúc đầu chỉ là một dải sóng. Nghe đủ nhiều, sóng tách ra thành từng từ, từng âm, rồi thành câu bạn tự nói được.
            </p>
          </SceneHead>
        </div>

        {/* The wave resolves into a sentence as it crosses the screen (and unresolves on the way back up). */}
        <div data-dive-track className={`${styles.track} ${styles.sound} space-y-6`}>
          <div className="relative">
            <div aria-hidden="true" className="pointer-events-none absolute -inset-x-[4%] -inset-y-[35%]" data-ocean-form="wave" data-ocean-tint="aqua" />
            <div className={styles.bars} aria-hidden="true">
              {BARS.map((h, i) => (
                <span key={i} style={{ '--h': h, '--i': (i / BAR_COUNT).toFixed(3) } as React.CSSProperties} />
              ))}
            </div>
          </div>
          <p className={styles.heard} lang="en">
            {HEARD.map((word, i) => (
              <span key={word + i} style={{ '--at': (i / HEARD.length).toFixed(3) } as React.CSSProperties}>
                {word}
              </span>
            ))}
          </p>
          <p className={`${styles.heardAfter} text-center text-base text-[#cfe2ff]`}>
            <span className="font-mono" lang="en">/ðə taɪd kʌmz ɪn twaɪs ə deɪ/</span>
            <span className="mx-2 opacity-50">·</span>
            Thủy triều lên hai lần mỗi ngày.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Dictation */}
          <div className={`${styles.pearl} ${styles.rise} space-y-4 p-6 sm:p-7`} style={{ '--lag': 0.35 } as React.CSSProperties} data-no-ripple>
            <div className="flex items-center justify-between gap-3">
              <span className={styles.chip}>Chép chính tả · Ví dụ minh họa</span>
              {canSpeak && (
                <button type="button" onClick={speak} className={`${styles.act} cursor-pointer`}>
                  <Volume2 aria-hidden="true" className="h-4 w-4" /> Nghe câu
                </button>
              )}
            </div>
            <form onSubmit={submit} className="space-y-4">
              <p className="text-lg font-semibold leading-loose text-[#0b2457]" lang="en">
                {DICTATION.before}{' '}
                <label htmlFor={inputId} className="sr-only">Từ còn thiếu trong câu</label>
                <input
                  id={inputId}
                  className={styles.blank}
                  value={check === 'shown' ? DICTATION.answer : typed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setCheck('idle');
                  }}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={20}
                />
                .
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className={`${styles.act} cursor-pointer`}>Kiểm tra</button>
                <button type="button" className={`${styles.actQuiet} cursor-pointer`} onClick={() => setCheck('shown')}>Xem đáp án</button>
              </div>
              <p className="min-h-[1.5rem] text-sm font-semibold" aria-live="polite">
                {check === 'right' && <span className="text-[#0b6b55]">Chính xác: bạn đã nghe ra “clearly”.</span>}
                {check === 'wrong' && <span className="text-[#9a3350]">Chưa đúng. {canSpeak ? 'Nghe lại rồi thử lần nữa nhé.' : 'Thử lại lần nữa nhé.'}</span>}
                {check === 'shown' && <span className="text-[#3b5387]">Đáp án là “clearly”.</span>}
                {check === 'idle' && <span className="font-normal text-[#3b5387]">{canSpeak ? 'Bấm Nghe câu, rồi gõ từ còn thiếu.' : 'Gõ từ bạn nghĩ là còn thiếu.'}</span>}
              </p>
            </form>
            <p className="text-xs leading-relaxed text-[#3b5387]">
              Trong bài luyện nghe thật, bạn chép từng câu của video và được chấm đến từng từ.
            </p>
          </div>

          {/* Pronunciation */}
          <div className={`${styles.pearl} ${styles.rise} space-y-4 p-6 sm:p-7`} style={{ '--lag': 0.45 } as React.CSSProperties} data-no-ripple>
            <span className={styles.chip}>Phát âm · Ví dụ minh họa</span>
            <p className="text-lg font-semibold text-[#0b2457]">
              Một từ là một chuỗi âm: <span lang="en" className="font-bold">think</span>
            </p>
            <div className="flex flex-wrap gap-3" role="group" aria-label="Các âm của từ think">
              {PHONEMES.map((item, index) => (
                <button
                  key={item.ipa}
                  type="button"
                  className={`${styles.phoneme} cursor-pointer font-mono`}
                  aria-pressed={phoneme === index}
                  aria-label={`Âm ${item.ipa}`}
                  onClick={() => setPhoneme(index)}
                >
                  {item.ipa}
                </button>
              ))}
            </div>
            <p className="min-h-[3.2rem] text-sm leading-relaxed text-[#1b3672]" aria-live="polite">
              <span className="font-mono font-bold">/{PHONEMES[phoneme].ipa}/</span> {PHONEMES[phoneme].tip}
            </p>
            <p className="text-xs leading-relaxed text-[#3b5387]">
              Trong phần luyện nói, bạn thu âm giọng mình, nói nhại theo câu mẫu và nhận góp ý về phát âm đến từng âm.
            </p>
          </div>
        </div>

        <div className={`flex flex-wrap justify-center gap-3 ${styles.rise}`} style={{ '--lag': 0.5 } as React.CSSProperties}>
          <DiveLink to="/listening">Luyện nghe và chép chính tả</DiveLink>
          <DiveLink to="/speaking" tone="ink">Luyện nói cùng AI</DiveLink>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────── 3 · The page opens ─────────────────────────────

const GLOSSES = {
  jot: { term: 'jot down', meaning: 'ghi nhanh lại', here: 'Ở câu này: mỗi tối ông chỉ ghi vội vài dòng, không phải ngồi viết dài.' },
  brought: { term: 'brought in', meaning: 'mang vào, đưa tới', here: 'Ở câu này: những thứ con nước cuốn dạt vào bờ.' },
  weathered: { term: 'weathered', meaning: 'sờn cũ vì mưa nắng', here: 'Ở câu này: cây đàn đã bạc màu sau thời gian dài trôi trên biển.' },
} as const;

type GlossKey = keyof typeof GLOSSES;

export function PageScene() {
  const [gloss, setGloss] = useState<GlossKey | null>(null);
  const [revised, setRevised] = useState(false);
  const term = (key: GlossKey) => (
    <button type="button" className={`${styles.term} cursor-pointer`} aria-pressed={gloss === key} onClick={() => setGloss(key)}>
      {GLOSSES[key].term}
    </button>
  );

  return (
    <section id="doc-viet" data-dive-scene data-dive-track className={styles.scene} aria-labelledby="doc-viet-title">
      <EchoLane id="doc-viet" say="Chạm vào cụm từ gạch chân thử xem!" />
      <div className="mx-auto max-w-6xl space-y-12 px-5 sm:px-8">
        <div className="grid items-end gap-8 lg:grid-cols-2 lg:gap-16">
          <SceneHead id="doc-viet" depth="Tầng 3 · Đọc và viết" title="Trang sách mở ra, câu chữ thành ý của bạn">
            <p className={styles.lead}>
              Từ lạ không cần tra rời rạc: bạn xem nghĩa của nó ngay trong câu đang đọc. Rồi đến lượt bạn viết, và nhận góp ý cho chính câu của mình.
            </p>
          </SceneHead>
          <div className={`space-y-5 ${styles.rise}`} style={{ '--lag': 0.18 } as React.CSSProperties}>
            <ul className={styles.points}>
              <li>Thư viện bài đọc, truyện song ngữ Anh và Việt, cùng sách của riêng bạn (EPUB, PDF, TXT)</li>
              <li>Phòng viết: luyện câu, luyện gõ, viết bài và nhận góp ý theo từng tiêu chí</li>
              <li>Học viện ngữ pháp theo chủ đề, luyện dịch từng câu và từng đoạn</li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <DiveLink to="/reading">Mở thư viện đọc</DiveLink>
              <DiveLink to="/writing" tone="ink">Vào phòng viết</DiveLink>
              <DiveLink to="/grammar" tone="ink">Học ngữ pháp</DiveLink>
            </div>
          </div>
        </div>

        <div className="relative">
          <div aria-hidden="true" className="pointer-events-none absolute -inset-x-[5%] -inset-y-[9%]" data-ocean-form="lines" data-ocean-tint="violet" />
          <div className={styles.book} data-no-ripple>
            <div className={`${styles.pearl} ${styles.page} ${styles.pageL}`}>
              <span className={`${styles.chip} self-start`}>Đọc · Ví dụ minh họa</span>
              <p className={styles.prose} lang="en">
                The lighthouse keeper kept a journal. Every evening he would {term('jot')} what the tide had {term('brought')}: driftwood, bottles, once even a{' '}
                {term('weathered')} violin.
              </p>
              <div className={styles.gloss} aria-live="polite">
                {gloss ? (
                  <>
                    <strong lang="en">{GLOSSES[gloss].term}</strong>: {GLOSSES[gloss].meaning}
                    <br />
                    {GLOSSES[gloss].here}
                  </>
                ) : (
                  'Chạm vào một cụm từ gạch chân để xem nghĩa của nó trong chính câu này.'
                )}
              </div>
            </div>

            <div className={`${styles.pearl} ${styles.page} ${styles.pageR}`}>
              <span className={`${styles.chip} self-start`}>Viết · Ví dụ minh họa</span>
              <p className={styles.prose} lang="en">
                {revised ? (
                  <>
                    I like reading<span className={styles.fix}>, whereas</span> my brother prefers games.
                  </>
                ) : (
                  <>
                    I like reading and my brother prefers games.
                  </>
                )}
              </p>
              <button type="button" onClick={() => setRevised((value) => !value)} className={`${styles.act} cursor-pointer self-start`} aria-pressed={revised}>
                <BrandWhaleIcon size="xs" className="shrink-0" />
                {revised ? 'Xem lại câu gốc' : 'Xem gợi ý của Echo'}
              </button>
              <div className={styles.gloss} aria-live="polite">
                {revised
                  ? 'Hai vế nói hai điều trái ngược. “Whereas” cho người đọc thấy ngay sự đối lập, điều mà “and” không làm được.'
                  : 'Câu này đúng ngữ pháp, nhưng hai ý trái ngược đang được nối như thể chúng giống nhau.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────── 4 · The chart ─────────────────────────────

// The drawn route follows the same curve as the ocean's `route` form (knowledgeForms.ts), so the light in the water
// runs along the line on the page.
const ROUTE_W = 1000;
const ROUTE_H = 272;
const routeY = (t: number) => ROUTE_H / 2 - Math.sin(t * Math.PI * 2 * 1.25 + 0.6) * 0.58 * (ROUTE_H / 2);
const ROUTE_PATH = Array.from({ length: 81 }, (_, i) => {
  const t = i / 80;
  return `${i === 0 ? 'M' : 'L'}${(t * ROUTE_W).toFixed(1)} ${routeY(t).toFixed(1)}`;
}).join(' ');

const STATIONS: { t: number; name: string; text: string; to: DiveDestination; cta: string }[] = [
  {
    t: 0.1,
    name: 'Biết mình đang ở đâu',
    text: 'Một bài xếp lớp nhanh cho bạn ước lượng ban đầu về trình độ. Đó là điểm xuất phát để chọn nội dung vừa sức, không phải một chứng chỉ.',
    to: '/progress',
    cta: 'Xem tiến trình học tập',
  },
  {
    t: 0.37,
    name: 'Hôm nay học gì?',
    text: 'Mỗi ngày một danh sách ngắn: ôn từ, đọc, nghe, nói, viết. Một nhiệm vụ chỉ được tính là xong khi bạn thật sự làm bài, không phải khi bạn mở trang.',
    to: '/learning-path',
    cta: 'Mở lộ trình học',
  },
  {
    t: 0.63,
    name: 'Thử sức với đề thi',
    text: 'Thi thử IELTS trong phòng thi trên máy tính và TOEIC với đồng hồ đếm giờ, hoặc luyện riêng từng phần khi bạn chưa muốn thi cả bài.',
    to: '/exams',
    cta: 'Vào khu thi thử',
  },
  {
    t: 0.9,
    name: 'Nhìn lại chặng đã qua',
    text: 'Chuỗi ngày học, lịch hoạt động và năng lực từng kỹ năng. Kỹ năng nào chưa đủ dữ liệu, hệ thống nói rõ là chưa đo được thay vì đoán.',
    to: '/progress',
    cta: 'Xem tiến trình học tập',
  },
];

export function ChartScene() {
  const [picked, setPicked] = useState(1);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (picked + step + STATIONS.length) % STATIONS.length;
    setPicked(next);
    tabs.current[next]?.focus();
  };

  return (
    <section id="lo-trinh" data-dive-scene data-dive-track className={styles.scene} aria-labelledby="lo-trinh-title">
      <EchoLane id="lo-trinh" say="Mỗi ngày một chặng, mình đi cùng bạn." />
      <div className="mx-auto max-w-6xl space-y-12 px-5 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <SceneHead id="lo-trinh" depth="Tầng 4 · Lộ trình và đánh giá" title="Hải đồ của riêng bạn">
            <p className={styles.lead}>
              Không ai học giống ai. Lộ trình bắt đầu từ trình độ thật của bạn, và mỗi ngày chỉ ra chặng kế tiếp.
            </p>
          </SceneHead>
        </div>

        <div data-dive-track className={`${styles.track} ${styles.chart}`} data-no-ripple>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden lg:block" data-ocean-form="route" data-ocean-tint="aqua" />
          <svg className={styles.route} viewBox={`0 0 ${ROUTE_W} ${ROUTE_H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="dive-route" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#7deeff" />
                <stop offset="0.55" stopColor="#c7b8ff" />
                <stop offset="1" stopColor="#ffe2a0" />
              </linearGradient>
            </defs>
            <path className={styles.routeGhost} d={ROUTE_PATH} vectorEffect="non-scaling-stroke" />
            <path className={styles.routeLine} d={ROUTE_PATH} pathLength={1} vectorEffect="non-scaling-stroke" />
          </svg>
          <div className={styles.stations} role="tablist" aria-label="Các chặng của lộ trình học" onKeyDown={onKey}>
            {STATIONS.map((station, index) => (
              <button
                key={station.name}
                ref={(el) => {
                  tabs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`chang-${index}`}
                aria-selected={picked === index}
                aria-controls="chang-panel"
                tabIndex={picked === index ? 0 : -1}
                onClick={() => setPicked(index)}
                className={`${styles.station} cursor-pointer`}
                style={{ '--x': `${station.t * 100}%`, '--y': `${(routeY(station.t) / ROUTE_H) * 100}%`, '--at': station.t } as React.CSSProperties}
              >
                <span className={styles.stationDot}>{index + 1}</span>
                <span>{station.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          id="chang-panel"
          role="tabpanel"
          aria-labelledby={`chang-${picked}`}
          className={`${styles.pearl} ${styles.rise} mx-auto max-w-3xl space-y-4 p-6 text-center sm:p-8 lg:mt-24`}
          style={{ '--lag': 0.3 } as React.CSSProperties}
          data-no-ripple
        >
          <p key={picked} className={`${styles.lens} space-y-3`}>
            <span className="block text-xl font-bold text-[#0b2457]">{STATIONS[picked].name}</span>
            <span className="block text-base leading-relaxed text-[#1b3672]">{STATIONS[picked].text}</span>
          </p>
          <DiveLink to={STATIONS[picked].to} tone="deep">{STATIONS[picked].cta}</DiveLink>
        </div>
        <p className={`${styles.note} ${styles.rise} text-center`} style={{ '--lag': 0.4 } as React.CSSProperties}>
          Lộ trình còn là một hành tinh nhỏ để bạn bay quanh và khám phá từng vùng: Echo Odyssey.
        </p>
      </div>
    </section>
  );
}

// ───────────────────────────── 5 · Open water ─────────────────────────────

const WORLDS: { id: string; name: string; hue: number; icon: React.ReactNode; text: string; to: DiveDestination; cta: string }[] = [
  {
    id: 'games',
    name: 'Trò chơi',
    hue: 268,
    icon: <Gamepad2 aria-hidden="true" className="h-7 w-7" />,
    text: 'Đua tri thức Echo Quiz Rush, Vua Tiếng Anh, Nối từ, Đoán từ, Card Blast và khu vườn Echo Garden. Chơi một mình, cùng Echo hoặc với bạn bè, và vẫn là đang ôn tiếng Anh.',
    to: '/games',
    cta: 'Vào khu trò chơi',
  },
  {
    id: 'cosmos',
    name: 'Vũ trụ tri thức',
    hue: 228,
    icon: <Orbit aria-hidden="true" className="h-7 w-7" />,
    text: 'Mỗi từ bạn đã học là một ngôi sao. Các từ nối với nhau bằng những quan hệ nghĩa có nguồn rõ ràng, và bầu trời lớn dần theo đúng việc học của bạn.',
    to: '/knowledge-universe',
    cta: 'Ngắm vũ trụ của bạn',
  },
  {
    id: 'study',
    name: 'Không gian học tập',
    hue: 190,
    icon: <Lamp aria-hidden="true" className="h-7 w-7" />,
    text: 'Một căn phòng 3D của riêng bạn, với đồng hồ tập trung, danh sách việc cần làm và sổ ghi chú. Khi muốn có bạn đồng hành, mời họ vào học cùng.',
    to: '/study-space',
    cta: 'Mở không gian học tập',
  },
  {
    id: 'community',
    name: 'Cộng đồng',
    hue: 205,
    icon: <Users aria-hidden="true" className="h-7 w-7" />,
    text: 'Hỏi khi bí, chia sẻ điều vừa học được, nhờ người khác sửa bài viết và nhắn tin với bạn học.',
    to: '/community',
    cta: 'Vào cộng đồng',
  },
  {
    id: 'hall',
    name: 'Bảng xếp hạng',
    hue: 42,
    icon: <Trophy aria-hidden="true" className="h-7 w-7" />,
    text: 'Bài học nào cũng được cộng điểm hoạt động. Bảng thi đua ghi nhận người học đều đặn mỗi tuần, mỗi tháng.',
    to: '/leaderboard',
    cta: 'Xem bảng xếp hạng',
  },
  {
    id: 'echo',
    name: 'AI Echo',
    hue: 176,
    icon: <BrandWhaleIcon size="sm" className="h-8 w-8" />,
    text: 'Người bạn đồng hành nhìn vào bảy ngày học gần nhất của bạn để gợi ý nên luyện gì tiếp theo. Tài khoản miễn phí cũng có lượt dùng AI mỗi ngày.',
    to: '/dashboard',
    cta: 'Gặp Echo ở trang học tập',
  },
];

export function WorldsScene() {
  const [picked, setPicked] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (picked + step + WORLDS.length) % WORLDS.length;
    setPicked(next);
    tabs.current[next]?.focus();
  };
  const world = WORLDS[picked];

  return (
    <section id="the-gioi" data-dive-scene data-dive-track className={`${styles.scene} !pb-4`} aria-labelledby="the-gioi-title">
      <EchoLane id="the-gioi" say="Còn nhiều vùng nước lắm, bơi tiếp nào!" />
      <div className="mx-auto max-w-6xl space-y-12 px-5 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <SceneHead id="the-gioi" depth="Tầng 5 · Vùng nước mở" title="Những vùng nước chờ bạn khám phá">
            <p className={styles.lead}>
              Học không chỉ nằm trong bài tập. Có nơi để chơi, nơi để tập trung, nơi nhìn thấy kiến thức của chính mình và nơi gặp người cùng học.
            </p>
          </SceneHead>
        </div>

        <div className="relative" data-no-ripple>
          <div aria-hidden="true" className="pointer-events-none absolute -inset-x-[2%] -inset-y-[30%]" data-ocean-form="cluster" data-ocean-tint="violet" />
          <div className={styles.worlds} role="tablist" aria-label="Các thế giới trong English Coach" onKeyDown={onKey}>
            {WORLDS.map((item, index) => (
              <button
                key={item.id}
                ref={(el) => {
                  tabs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`vung-${item.id}`}
                aria-selected={picked === index}
                aria-controls="vung-panel"
                tabIndex={picked === index ? 0 : -1}
                onClick={() => setPicked(index)}
                className={`${styles.world} ${styles.rise} cursor-pointer`}
                style={{ '--k': index - (WORLDS.length - 1) / 2, '--hue': item.hue, '--lag': 0.1 + index * 0.04 } as React.CSSProperties}
              >
                <span className={styles.porthole}>{item.icon}</span>
                <span>{item.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          id="vung-panel"
          role="tabpanel"
          aria-labelledby={`vung-${world.id}`}
          className={`${styles.pearl} ${styles.rise} mx-auto max-w-3xl space-y-4 p-6 text-center sm:p-8`}
          style={{ '--lag': 0.3 } as React.CSSProperties}
          data-no-ripple
        >
          <p key={world.id} className={`${styles.lens} space-y-3`}>
            <span className="block text-xl font-bold text-[#0b2457]">{world.name}</span>
            <span className="block text-base leading-relaxed text-[#1b3672]">{world.text}</span>
          </p>
          <DiveLink to={world.to} tone="deep">{world.cta}</DiveLink>
        </div>
      </div>
    </section>
  );
}
