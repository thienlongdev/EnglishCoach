// Publication is explicit. Only reviewed, anonymous, server-rendered pages belong here.
export const ORIGIN = 'https://englishcoach.io.vn';
export const SITE_NAME = 'Echo English Coach';
export const PUBLIC_PAGES = {
  '/': { title: 'English Coach', description: 'Echo English Coach giúp người Việt tự học tiếng Anh. Thử bài nghe chép chính tả có lời giải, học từ qua ngữ cảnh và khám phá công cụ luyện IELTS, TOEIC.' },
  '/echo-anywhere': { title: 'Echo Anywhere', description: 'Echo Anywhere 1.0.1: tra và lưu từ trên web, học với bản chép lời YouTube truy cập được, phụ đề Anh–Việt, lời nhạc và luyện nghe. Cài từ Chrome Web Store.' },
  '/huong-dan': { title: 'Hướng dẫn tự học tiếng Anh', description: 'Chọn bài thực hành nghe chép chính tả hoặc học từ qua ngữ cảnh. Mỗi bài có ví dụ, cách tự kiểm tra và đường dẫn đến công cụ luyện tập.' },
  '/huong-dan/nghe-chep-chinh-ta': { title: 'Cách luyện nghe chép chính tả tiếng Anh', description: 'Luyện tách âm, nhận ra từ yếu và kiểm tra đuôi từ qua một câu mẫu. Dùng bảng chẩn đoán để chọn phần cần nghe lại.' },
  '/huong-dan/hoc-tu-trong-ngu-canh': { title: 'Cách học từ tiếng Anh trong ngữ cảnh', description: 'Thử đoán hai nghĩa của charge, kiểm tra bằng cụm từ đi kèm rồi tạo một thẻ từ có câu hỏi và ví dụ riêng.' },
} as const;
export type PublicPath = keyof typeof PUBLIC_PAGES;
export const isCanonicalHost = (host: string | null) => host?.toLowerCase() === 'englishcoach.io.vn';
