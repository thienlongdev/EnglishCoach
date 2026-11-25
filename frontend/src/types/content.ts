export interface FeedArticleItem {
  id: number;
  source: string;
  title: string;
  url: string;
  thumbnail: string | null;
  summary: string | null;
  category: string | null;
  level: string;
  readMinutes: number;
  publishedAt: string;
}

export interface ListeningTodayItem {
  id: number;
  kind: string;
  source?: 'LIBRARY' | 'SEED';
  title: string;
  channel: string | null;
  topic: string | null;
  level: string;
  accent: string | null;
  durationSeconds: number;
  audioUrl: string | null;
  thumbnail: string | null;
  youtubeVideoId: string | null;
  hasTranscript: boolean;
  deepLink?: string;
}

export interface DictationTodayItem {
  id: number;
  segmentId?: number | null;
  source?: 'LIBRARY' | 'SEED';
  title: string;
  level: string;
  accent: string | null;
  topic: string | null;
  durationSeconds: number;
  audioUrl: string | null;
  transcriptHidden: boolean;
  transcript?: string;
  startSeconds?: number | null;
  endSeconds?: number | null;
  deepLink?: string;
  youtubeVideoId?: string | null;
}

export interface TrendingVocabularyItem {
  id: number;
  word: string;
  lemma: string | null;
  phonetic: string | null;
  meaning: string;
  exampleSentence: string | null;
  frequency: number;
}

export interface ContentVocabularyItem {
  id: number;
  word: string;
  lemma: string | null;
  phonetic: string | null;
  meaning: string;
  exampleSentence: string | null;
  frequency?: number;
}

export interface ReadingArticleDetail {
  articleId: number;
  title: string;
  source: string;
  url: string;
  level: string;
  wordCount: number;
  readMinutes: number;
  content: string;
  contentMode?: 'FULL_TEXT' | 'SUMMARY_LINK';
  sourceUrl?: string | null;
  saved?: boolean;
  vocabulary: ContentVocabularyItem[];
}

