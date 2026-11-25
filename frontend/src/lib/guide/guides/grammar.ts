import type { GuideDef, GuideText } from '../types';

const t = (vi: string, en: string): GuideText => ({ vi, en });

/**
 * Echo Grammar Academy (`/grammar`). Two short tours on the real controls: the home, and a lesson. Nothing here promises a score,
 * a band or an expert review: the status words are the ones the page itself shows.
 */
export const GRAMMAR_GUIDES: GuideDef[] = [
  {
    id: 'grammar',
    module: 'grammar',
    level: 'module',
    version: 1,
    title: t('Ngữ pháp', 'Grammar'),
    summary: t('Tìm chủ đề, học bài, luyện tập và xem lỗi của mình.', 'Find a topic, learn it, practise and see your own mistakes.'),
    path: '/grammar',
    home: '/grammar',
    offer: true,
    steps: [
      {
        id: 'start',
        target: '[data-guide="grammar-next"], [data-guide="grammar-diagnostic"]',
        title: t('Bắt đầu từ đây', 'Start here'),
        body: t('Chưa có mức thì làm bài chẩn đoán ngắn. Đã có mức thì mở bài tiếp theo.', 'No level yet? Take the short diagnostic. Otherwise open the next lesson.'),
        waitMs: 1500,
      },
      {
        id: 'search',
        target: '[data-guide="grammar-search"]',
        title: t('Tìm đúng chủ đề', 'Find the right topic'),
        body: t('Gõ tiếng Việt hoặc tiếng Anh, ví dụ “since for” hay “mạo từ”. Kết quả hiện ngay.', 'Type Vietnamese or English, such as “since for” or “mạo từ”. Results appear at once.'),
        waitMs: 900,
      },
      {
        id: 'path',
        target: '[data-guide="grammar-path"]',
        title: t('Lộ trình và tiến độ', 'Your path and progress'),
        body: t('Vòng quanh mỗi trạm là số chủ đề bạn đã nắm. Chủ đề chưa có bài ghi “Đang biên soạn”.', 'The ring at each station counts topics you have mastered. Topics without a lesson say “In preparation”.'),
        waitMs: 900,
      },
      {
        id: 'visual',
        target: null,
        title: t('Giải thích bằng hình', 'Explained with pictures'),
        body: t('Mỗi bài có hình bấm được: dòng thời gian, sơ đồ chọn, biến đổi câu. Mở một bài để thử.', 'Lessons have pictures you can press: timelines, choice flows, sentence changes. Open one to try.'),
      },
      {
        id: 'practice',
        target: '[data-guide="grammar-nav-practice"]',
        title: t('Luyện tập riêng', 'Practice on its own'),
        body: t('Trộn câu hỏi các chủ đề, hoặc chỉ ôn lỗi của bạn và bài đến hạn.', 'Mix questions from many topics, or only your mistakes and what is due.'),
      },
      {
        id: 'mistakes',
        target: '[data-guide="grammar-nav-mistakes"]',
        title: t('Lỗi của tôi', 'My mistakes'),
        body: t('Câu làm sai được gom theo kiểu lỗi, kèm bài để học lại và nút luyện lại.', 'Wrong answers are grouped by kind of mistake, with the lesson and a button to practise again.'),
      },
    ],
  },
  {
    id: 'grammar-lesson',
    module: 'grammar',
    level: 'feature',
    version: 1,
    title: t('Một bài ngữ pháp', 'A grammar lesson'),
    summary: t('Ba tầng bài học, hình tương tác, luyện tập và kiểm tra.', 'Three layers, pictures you can press, practice and a check.'),
    path: /^\/grammar\/topics\/[^/]+$/,
    home: null,
    gate: '[data-guide="grammar-layers"]',
    offer: true,
    entryOnly: true,
    steps: [
      {
        id: 'layers',
        target: '[data-guide="grammar-layers"]',
        title: t('Ba tầng bài học', 'Three layers'),
        body: t('Nhanh để xem lại, Bài học để học lần đầu, Chuyên sâu cho ngoại lệ và lý do.', 'Quick to revise, Lesson to learn it, Deep for exceptions and reasons.'),
        waitMs: 1200,
      },
      {
        id: 'diagram',
        target: '[data-guide="grammar-diagram"]',
        title: t('Hình bấm được', 'Pictures you can press'),
        body: t('Rê chuột hoặc bấm vào hình để xem từng phần. Bài không có hình thì bước này bị bỏ qua.', 'Hover or press a picture to see each part. Lessons without one skip this step.'),
        waitMs: 1200,
      },
      {
        id: 'practice',
        target: '[data-guide="grammar-practice"]',
        title: t('Làm thử ngay', 'Try it now'),
        body: t('Trả lời từng câu rồi nhấn Kiểm tra để xem giải thích. Câu luyện tập không đổi trạng thái chủ đề.', 'Answer a question, then press Check for the explanation. Practice never changes the topic status.'),
        place: 'top',
        waitMs: 1200,
      },
      {
        id: 'check',
        target: '[data-guide="grammar-check"]',
        title: t('Kiểm tra chủ đề', 'Check the topic'),
        body: t('Chỉ bài kiểm tra mới ghi chủ đề là đã nắm, và chỉ khi bạn đạt ngưỡng.', 'Only a check can mark the topic as mastered, and only if you reach the pass mark.'),
        waitMs: 900,
      },
      {
        id: 'save',
        target: '[data-guide="grammar-bookmark"]',
        title: t('Lưu để quay lại', 'Save to come back'),
        body: t('Lưu bài vào danh sách của bạn rồi lọc lại trong Thư viện.', 'Save the lesson to your list, then filter for it in the Library.'),
        waitMs: 900,
      },
    ],
  },
];
