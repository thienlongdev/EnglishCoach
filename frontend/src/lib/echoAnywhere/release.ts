import { ECHO_ANYWHERE_STORES } from './client';

/** Only publicly verified releases belong here. Never promote a submitted/review-pending package.
 * Verified in the official store on 2026-11-18 ICT; store date: 2026-11-17.
 * Installation URLs remain owned by ECHO_ANYWHERE_STORES in client.ts.
 */
export const ECHO_ANYWHERE_RELEASE = {
  status: 'published',
  version: '1.0.1',
  publishedAt: '2026-11-17',
  title: 'Echo Anywhere 1.0.1 đã ra mắt!',
  titleEn: 'Echo Anywhere 1.0.1 is here!',
  summary: 'Học từ video YouTube có bản chép lời truy cập được, luyện nghe với phụ đề, khám phá lời nhạc và tra, lưu từ ngay trong ngữ cảnh.',
  summaryEn: 'Learn from accessible YouTube transcripts, practise with subtitles, explore lyrics and look up or save words in context.',
  highlights: [
    'Echo Video Companion: bản chép lời YouTube truy cập được, câu có mốc thời gian, tua và lặp đoạn.',
    'Phụ đề Anh–Việt từ nguồn có sẵn, bản dịch được phép hoặc tệp SRT/VTT bạn có quyền sử dụng.',
    'Echo Lyrics Lab: hiểu trích đoạn lời nhạc được phép sử dụng, tiếng lóng, nghĩa bóng và phát âm.',
    'Karaoke và luyện nghe: chép chính tả, điền từ, xếp lại câu và hiểu nội dung từ học liệu sẵn có.',
    'Tra và lưu từ nhanh trong ngữ cảnh; kiểm tra nguồn tiếng Anh trước khi gửi.',
    'Đồng ý chia sẻ nội dung riêng theo phạm vi; tận dụng từ điển, bản dịch và xử lý cục bộ để giảm AI không cần thiết.',
  ],
  highlightsEn: [
    'Echo Video Companion: accessible YouTube transcripts, timestamped sentences, seeking and repeat.',
    'English–Vietnamese subtitles from available tracks, permitted translation or authorized SRT/VTT files.',
    'Echo Lyrics Lab: authorized excerpts, slang, figurative meaning and pronunciation.',
    'Karaoke and listening: dictation, missing words, sentence reconstruction and comprehension.',
    'Contextual word lookup and saving, with English-source validation before sending.',
    'Scoped private-content consent and reuse of dictionaries, translations and local processing to avoid unnecessary AI.',
  ],
  changelogUrl: '/echo-anywhere#co-gi-moi',
  chromeWebStoreUrl: ECHO_ANYWHERE_STORES.chrome,
} as const;

/** Chrome manifest versions are numeric, not lexical (1.0.10 is newer than 1.0.9). */
export function releaseVersionState(installed: string, published = ECHO_ANYWHERE_RELEASE.version as string): 'current' | 'older' | 'newer' | 'unknown' {
  const parse = (value: string) => /^\d+(?:\.\d+){0,3}$/.test(value)
    ? value.split('.').map(Number) : null;
  const a = parse(installed), b = parse(published);
  if (!a || !b || [...a, ...b].some((n) => n > 65535)) return 'unknown';
  for (let i = 0; i < 4; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return 'older';
    if ((a[i] || 0) > (b[i] || 0)) return 'newer';
  }
  return 'current';
}

export function publishedReleaseAvailable(release: { status: string; publishedAt: string }, now = Date.now()): boolean {
  const date = Date.parse(`${release.publishedAt}T00:00:00+07:00`);
  return release.status === 'published' && Number.isFinite(date) && date <= now;
}
