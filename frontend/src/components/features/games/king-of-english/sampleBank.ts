import { contentFingerprint, createContentProvider, validateBank } from './domain';
import type { ReorderChallenge } from './domain';

// Manually authored specifically for this local architecture fixture. No external
// attribution, scraping, owner review, runtime authoring or human approval claim.
const policy = Object.freeze({ case: 'INSENSITIVE', punctuation: 'SENTENCE_MARKS' } as const);
function fixture(id: string, category: string, cefr: ReorderChallenge['cefr'], tokens: string[], canonicalAnswer: string,
  meaningVi: string, explanationVi: string, explanationEn: string, acceptedAnswers: string[] = []): ReorderChallenge {
  const content = { tokens: Object.freeze(tokens), canonicalAnswer, acceptedAnswers: Object.freeze(acceptedAnswers), policy };
  return Object.freeze({ ...content, id, mode: 'REORDER', category, cefr, difficulty: cefr === 'A1' ? 1 : cefr === 'A2' ? 2 : 3,
    meaning: Object.freeze({ vi: meaningVi, en: canonicalAnswer }), explanation: Object.freeze({ vi: explanationVi, en: explanationEn }),
    sourceKind: 'MANUALLY_AUTHORED_LOCAL_FIXTURE', sourceRef: `king-phase1-local:${id}`, contentVersion: '1.0.0',
    fingerprint: contentFingerprint(content), reviewStatus: 'AUTO_VALIDATED', humanReview: null });
}
export const SAMPLE_BANK: readonly ReorderChallenge[] = Object.freeze([
  fixture('koe-01', 'SIMPLE_SENTENCE', 'A1', ['She', 'likes', 'green', 'tea'], 'She likes green tea.', 'Cô ấy thích trà xanh.', 'Chủ ngữ + động từ + tân ngữ.', 'Subject + verb + object.'),
  fixture('koe-02', 'QUESTION', 'A1', ['Where', 'do', 'you', 'live'], 'Where do you live?', 'Bạn sống ở đâu?', 'Where + do + chủ ngữ + động từ.', 'Where + do + subject + verb.'),
  fixture('koe-03', 'NEGATIVE', 'A1', ['I', 'do', 'not', 'eat', 'meat'], 'I do not eat meat.', 'Tôi không ăn thịt.', 'Do not đứng trước động từ nguyên mẫu.', 'Do not precedes the base verb.'),
  fixture('koe-04', 'PAST_TENSE', 'A2', ['I', 'went', 'there', 'yesterday'], 'I went there yesterday.', 'Hôm qua tôi đã đến đó.', 'Yesterday có thể đứng đầu hoặc cuối câu.', 'Yesterday can begin or end this sentence.', ['Yesterday, I went there.']),
  fixture('koe-05', 'COLLOCATION', 'A2', ['Please', 'make', 'a', 'decision'], 'Please make a decision.', 'Hãy đưa ra quyết định.', 'Cụm từ: make a decision.', 'The collocation is make a decision.'),
  fixture('koe-06', 'PHRASAL_VERB', 'A2', ['Please', 'turn', 'off', 'the', 'light'], 'Please turn off the light.', 'Hãy tắt đèn.', 'Turn off: tắt; tân ngữ có thể đứng giữa turn và off.', 'Turn off means stop the light; the noun object may also separate turn and off.', ['Please turn the light off.']),
  fixture('koe-07', 'FIXED_EXPRESSION', 'A2', ['Thank', 'you', 'very', 'much'], 'Thank you very much.', 'Cảm ơn bạn rất nhiều.', 'Thank you very much là một cách cảm ơn.', 'Thank you very much is a fixed expression of gratitude.'),
  fixture('koe-08', 'IDIOM', 'B1', ['This', 'test', 'is', 'a', 'piece', 'of', 'cake'], 'This test is a piece of cake.', 'Bài kiểm tra này rất dễ.', 'A piece of cake: việc rất dễ làm.', 'A piece of cake means something very easy.'),
  fixture('koe-09', 'PRESENT_CONTINUOUS', 'A2', ['They', 'are', 'playing', 'football'], 'They are playing football.', 'Họ đang chơi bóng đá.', 'Are + động từ đuôi ing: hành động đang diễn ra.', 'Are + an ing verb describes an action in progress.'),
  fixture('koe-10', 'FUTURE', 'A2', ['We', 'will', 'meet', 'tomorrow'], 'We will meet tomorrow.', 'Chúng ta sẽ gặp nhau ngày mai.', 'Will + động từ nguyên mẫu.', 'Will precedes the base verb.', ['Tomorrow, we will meet.']),
  fixture('koe-11', 'QUESTION', 'A1', ['Can', 'you', 'help', 'me'], 'Can you help me?', 'Bạn có thể giúp tôi không?', 'Can + chủ ngữ + động từ nguyên mẫu.', 'Can + subject + base verb forms this question.'),
  fixture('koe-12', 'PRESENT_PERFECT', 'A2', ['She', 'has', 'finished', 'her', 'homework'], 'She has finished her homework.', 'Cô ấy đã làm xong bài tập.', 'Has + quá khứ phân từ.', 'Has + past participle forms the present perfect.'),
]);

// Automatic structural validation is not human review or linguistic certification.
if (validateBank(SAMPLE_BANK).length) throw new Error('King local fixture failed validation');
export const localContent = createContentProvider(SAMPLE_BANK, 'LOCAL_FIXTURE', process.env.NODE_ENV);
