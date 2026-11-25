'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { CircleHelp, Loader2, MessageCircleQuestion, Search } from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { useLanguage } from '@/context/LanguageContext';
import { grammarApi } from '@/services/grammarApi';
import { useGrammarUserId } from '@/hooks/useGrammar';
import { professorAction, restoreProfessorAction } from '@/lib/grammar/professor-retry';
import { apiFailure, cx } from '@/lib/grammar/format';
import { foldTokens } from '@/lib/grammar/inline';
import type { ProfessorAnswer, Topic } from '@/types/grammar';
import { En, Vi } from './Inline';
import styles from './grammar.module.css';

/** Words too common to say anything about a question (folded, Vietnamese and English). */
const STOP = new Set([
  'la', 'co', 'khong', 'va', 'cua', 'cho', 'voi', 'nao', 'gi', 'thi', 'o', 'de', 'mot', 'nhung', 'cac', 'duoc', 'nay', 'do', 'khi', 'sao', 'nhu', 'the',
  'bi', 'se', 'da', 'dang', 'roi', 'hay', 'hoac', 'neu', 'vi', 'tai', 'trong', 'ra', 'vao', 'lai', 'cung', 'rat', 'ma', 'ai', 'em', 'minh', 'toi', 'ban',
  'the', 'a', 'an', 'is', 'are', 'it', 'to', 'of', 'in', 'on', 'and', 'or', 'do', 'does', 'how', 'what', 'why', 'when', 'can', 'i', 'you',
]);

interface Hit { i: number; score: number }

/** Folded token overlap between the question and each FAQ entry; the question text counts double. No request is made. */
export function matchFaq(query: string, faq: Topic['faq']): Hit[] {
  const wanted = [...new Set(foldTokens(query).filter((t) => t.length > 1 && !STOP.has(t)))];
  if (!wanted.length) return [];
  const hits: Hit[] = [];
  faq.forEach((f, i) => {
    const qTokens = new Set(foldTokens(f.q));
    const aTokens = new Set(foldTokens(f.a));
    let score = 0;
    let matched = 0;
    for (const w of wanted) {
      const near = (set: Set<string>) => set.has(w) || (w.length >= 4 && [...set].some((t) => t.length >= 4 && (t.startsWith(w) || w.startsWith(t))));
      if (near(qTokens)) { score += 2; matched++; } else if (near(aTokens)) { score += 1; matched++; }
    }
    if (matched && (matched >= 2 || wanted.length === 1 || matched / wanted.length >= 0.5)) hits.push({ i, score: score + matched / wanted.length });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}

const CONFIDENCE = {
  HIGH: { vi: 'Độ tin cậy: cao', en: 'Confidence: high' },
  MEDIUM: { vi: 'Độ tin cậy: vừa, hãy đối chiếu với bài', en: 'Confidence: medium, compare with the lesson' },
  LOW: { vi: 'Độ tin cậy: thấp, hãy đối chiếu kỹ với bài', en: 'Confidence: low, check it carefully against the lesson' },
} as const;

/**
 * Questions about this lesson. First a local answer: what you type is matched to the lesson's own FAQ with no request. Then,
 * only when you press the button, an AI answer grounded in the lesson (it spends one of your AI uses), labelled as AI, with its
 * confidence. The lesson never depends on this panel.
 */
export function Professor({ topic, faq }: { topic: string; faq: Topic['faq'] }) {
  const userId = useGrammarUserId();
  return <ProfessorForm key={`${userId ?? 'anonymous'}:${topic}`} userId={userId} topic={topic} faq={faq} />;
}

function ProfessorForm({ userId, topic, faq }: { userId: string | null; topic: string; faq: Topic['faq'] }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const uid = useId();
  const { data: capabilities, error: availabilityError, mutate: mutateCapabilities } = useSWR(
    userId ? ['grammar-capabilities', userId] : null,
    grammarApi.capabilities,
    { shouldRetryOnError: false, dedupingInterval: 30_000 },
  );
  const available = !availabilityError && capabilities?.professorAvailable === true;
  const [question, setQuestion] = useState('');
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ProfessorAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const flight = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (!userId) return;
    try {
      const saved = restoreProfessorAction(window.sessionStorage, userId, topic);
      if (saved) {
        setQuestion(saved.question); setSentence(saved.sentence);
        pending.current = { key: JSON.stringify([topic, saved.question, saved.sentence]), id: saved.id };
      }
    } catch { /* The form still works when browser storage is blocked. */ }
  }, [userId, topic]);

  const hits = useMemo(() => matchFaq(question, faq), [question, faq]);
  const ready = question.trim().length >= 3;

  const ask = async (forceNew = false) => {
    if (!available || !userId || !ready || flight.current) return;
    flight.current = true;
    setBusy(true);
    setProblem(null);
    setLimit(false);
    setInterrupted(false);
    setAnswer(null);
    const questionText = question.trim();
    const sentenceText = sentence.trim() || undefined;
    const key = JSON.stringify([topic, questionText, sentenceText ?? '']);
    if (forceNew || !pending.current || pending.current.key !== key) {
      let id = crypto.randomUUID();
      try { id = professorAction(window.sessionStorage, userId, topic, questionText, sentenceText ?? '', forceNew).id; }
      catch { /* Same-mounted retries use the ref if browser storage is blocked. */ }
      pending.current = { key, id };
    }
    try {
      setAnswer(await grammarApi.askProfessor(topic, questionText, sentenceText, pending.current.id));
    } catch (err) {
      const { status, code } = apiFailure(err);
      if (code === 'PROFESSOR_DISABLED') {
        void mutateCapabilities({ professorAvailable: false }, { revalidate: false });
        setAnswer(null);
      } else if (status === 403) {
        setLimit(true);
        setProblem(vi
          ? 'Bạn đã dùng hết lượt AI hôm nay, hoặc tính năng này cần gói Premium. Bài học và các câu hỏi thường gặp vẫn dùng bình thường.'
          : 'You have used today’s AI allowance, or this needs Premium. The lesson and its FAQ still work as usual.');
      } else if (code === 'PROFESSOR_INTERRUPTED' || code === 'REQUEST_ID_REUSED') {
        setInterrupted(true);
        setProblem(vi ? 'Chưa thể khôi phục kết quả của yêu cầu trước. Hệ thống không tự gọi AI lại. Bạn có thể gửi một yêu cầu mới; thao tác đó có thể dùng thêm lượt AI.' : 'The previous result cannot be recovered yet. AI is not called again automatically. You can send a new request; that action may use another AI allowance.');
      } else if (status === 409) {
        setProblem(vi ? 'Yêu cầu này đang được xử lý. Đợi một chút rồi thử lại; gửi lại yêu cầu này không trừ thêm lượt.' : 'This request is still processing. Wait and retry; retrying this request does not spend another use.');
      } else if (status === 429) {
        setProblem(vi ? 'Bạn hỏi hơi nhanh. Đợi một chút rồi thử lại.' : 'You are asking quickly. Wait a moment and try again.');
      } else if (status === 503) {
        setProblem(vi
          ? 'Giáo sư Echo đang bận hoặc chưa trả lời được lúc này. Bài học không phụ thuộc vào Giáo sư; bạn có thể thử lại sau.'
          : 'The Professor is busy or cannot answer right now. The lesson does not depend on it; try again later.');
      } else {
        setProblem(vi ? 'Chưa gửi được câu hỏi. Hãy thử lại.' : 'The question could not be sent. Please try again.');
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={styles.prof} aria-labelledby={`${uid}-t`}>
      <header className={styles.profHead}>
        <span className={styles.profMark} aria-hidden="true"><MessageCircleQuestion /></span>
        <div>
          <h2 id={`${uid}-t`} className={styles.sectionTitle}>{vi ? 'Hỏi về bài này' : 'Ask about this lesson'}</h2>
          <p className={styles.sectionLead}>
            {vi
              ? 'Gõ câu hỏi: bạn sẽ thấy ngay những câu hỏi thường gặp của bài khớp với nó, không tốn lượt AI nào.'
              : 'Type a question: the lesson’s own FAQ that matches it appears at once, using no AI.'}
          </p>
        </div>
      </header>

      <div className={styles.profField}>
        <label htmlFor={`${uid}-q`} className={styles.fieldLabel}>{vi ? 'Câu hỏi của bạn' : 'Your question'}</label>
        <div className={styles.profInputWrap}>
          <Search aria-hidden="true" />
          <textarea
            id={`${uid}-q`}
            className={styles.profInput}
            rows={2}
            maxLength={500}
            disabled={busy}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={vi ? 'Ví dụ: today đi với thì nào?' : 'For example: which tense goes with today?'}
          />
        </div>
      </div>

      {question.trim().length >= 2 ? (
        <div className={styles.profHits} aria-live="polite">
          {hits.length ? (
            <>
              <p className={styles.profHitsTitle}>{vi ? 'Có thể bạn đang hỏi' : 'You may be asking'}</p>
              {hits.map((h) => (
                <details key={h.i} className={styles.faqItem} open={hits.length === 1}>
                  <summary className={styles.faqQ}><CircleHelp aria-hidden="true" /><Vi text={faq[h.i].q} /></summary>
                  <p className={styles.faqA}><Vi text={faq[h.i].a} /></p>
                </details>
              ))}
            </>
          ) : (
            <p className={styles.profNone}>{vi ? 'Chưa thấy câu nào khớp trong phần câu hỏi thường gặp của bài.' : 'Nothing in this lesson’s FAQ matches yet.'}</p>
          )}
        </div>
      ) : null}

      {available ? <details className={styles.profMore}>
        <summary>{vi ? 'Thêm một câu bạn đang thắc mắc (không bắt buộc)' : 'Add a sentence you are unsure about (optional)'}</summary>
        <input
          className={cx(styles.input, styles.profSentence)}
          lang="en"
          value={sentence}
          maxLength={300}
          disabled={busy}
          onChange={(e) => setSentence(e.target.value)}
          aria-label={vi ? 'Câu tiếng Anh bạn thắc mắc' : 'The English sentence you are unsure about'}
          placeholder="I have seen him yesterday."
          autoCapitalize="off"
          spellCheck={false}
        />
      </details> : null}

      {available ? <div className={styles.profAsk}>
        <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void ask(); }} disabled={!userId || !ready || busy}>
          {busy ? <Loader2 className={styles.spin} aria-hidden="true" /> : <BrandWhaleIcon size="sm" clean />}
          {busy ? (vi ? 'Giáo sư đang soạn câu trả lời…' : 'The Professor is writing…') : (vi ? 'Hỏi Giáo sư Echo' : 'Ask Professor Echo')}
        </button>
        <p className={styles.profAi}>{vi ? 'Câu trả lời do AI soạn dựa trên bài học và dùng một lượt AI của bạn.' : 'The answer is written by AI from the lesson and uses one of your AI uses.'}</p>
      </div> : <p className={styles.profAi} role="status">{vi ? 'Giáo sư Echo hiện tạm ngưng. Bạn vẫn có thể tra câu hỏi thường gặp, học bài và luyện tập bình thường.' : 'Professor Echo is currently unavailable. You can still use the lesson FAQ, study and practise as usual.'}</p>}

      {available && problem ? (
        <div className={styles.profProblem} role="alert">
          <p>{problem}</p>
          {interrupted ? <button type="button" className={cx(styles.btn, styles.btnSoft)} disabled={busy} onClick={() => { void ask(true); }}>{vi ? 'Gửi yêu cầu mới (dùng lượt AI)' : 'Send a new request (uses AI allowance)'}</button> : null}
          {limit ? <Link href="/premium" className={styles.inlineLink}>{vi ? 'Xem gói Premium' : 'See Premium'}</Link> : null}
        </div>
      ) : null}

      {available && answer ? (
        <div className={styles.profAnswer} aria-live="polite">
          <div className={styles.profAnswerHead}>
            <span className={styles.aiBadge}><BrandWhaleIcon size="xs" clean />{vi ? 'Trả lời do AI soạn' : 'Written by AI'}</span>
            <span className={styles.profConf} data-level={answer.confidence}>{vi ? CONFIDENCE[answer.confidence].vi : CONFIDENCE[answer.confidence].en}</span>
          </div>
          <p className={styles.profText}><Vi text={answer.answer} /></p>
          {answer.examples.length ? (
            <ul className={styles.examples}>
              {answer.examples.map((e, i) => (
                <li key={i} className={styles.example}>
                  <div className={styles.exBody}>
                    <p className={styles.exEn}><En text={e.en} /></p>
                    {e.vi ? <p className={styles.exVi}><Vi text={e.vi} /></p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.profCheck}>{vi ? 'AI có thể sai. Hãy đối chiếu với phần bài học ở trên.' : 'AI can be wrong. Compare it with the lesson above.'}</p>
        </div>
      ) : null}
    </section>
  );
}
