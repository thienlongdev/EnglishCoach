export interface BilingualReadingCard {
  id: number;
  contentType: 'ARTICLE' | 'STORY';
  titleEn: string;
  titleVi?: string | null;
  difficultyLevel?: string | null;
  wordCount: number;
  estimatedMinutes: number;
}

export interface BilingualReadingCatalog {
  catalogRevision: string;
  totalElements: number;
  articleCount: number;
  storyCount: number;
  content: BilingualReadingCard[];
}

export interface BilingualReadingDetail extends BilingualReadingCard {
  segments: Array<{ position: number; en: string; vi: string; sourceReference?: string | null }>;
}
