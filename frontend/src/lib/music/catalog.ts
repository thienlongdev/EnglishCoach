import type { MusicTrack } from './model';

// Original recordings and official cover artwork, delivered directly by the artist.
// Track pages explicitly license the music CC BY 4.0; attribution stays visible in both players.
export const MUSIC_CATALOG: MusicTrack[] = [
  { id: 'sb-reverie', title: 'Reverie', mood: 'piano', accent: '#ba9ef7', url: '2020/03/sb_reverie.mp3', artwork: '2020/03/Reverie-wide-01.png', creditUrl: 'reverie' },
  { id: 'sb-moonlight', title: 'Moonlight', mood: 'night', accent: '#8daef1', url: '2022/07/Moonlight.mp3', artwork: '2022/07/Moonlight-wide-01.jpg', creditUrl: 'moonlight' },
  { id: 'sb-jul', title: 'Jul', mood: 'calm', accent: '#e3bd82', url: '2020/12/sb_jul.mp3', artwork: '2020/12/Jul-wide-01.jpg', creditUrl: 'jul' },
  { id: 'sb-solitude', title: 'In Search Of Solitude', mood: 'focus', accent: '#8fceba', url: '2022/05/sb_insearchofsolitude.mp3', artwork: '2022/05/InSearchOfSolitude-Wide-01.jpg', creditUrl: 'in-search-of-solitude' },
  { id: 'sb-undertow', title: 'Undertow', mood: 'ambient', accent: '#82b5c7', url: '2019/12/sb_undertow.mp3', artwork: '2019/12/Undertow-Wide.jpg', creditUrl: 'undertow' },
  { id: 'sb-adrift', title: 'Adrift Among Infinite Stars', mood: 'ambient', accent: '#b6a4eb', url: '2022/02/AdriftAmongInfiniteStars.mp3', artwork: '2022/02/Adrift-Wide-01.jpg', creditUrl: 'adrift-among-infinite-stars' },
].map(track => ({ ...track, source: 'curated', artist: 'Scott Buckley',
  url: `https://www.scottbuckley.com.au/library/wp-content/uploads/${track.url}`,
  artwork: `https://www.scottbuckley.com.au/library/wp-content/uploads/${track.artwork}`,
  creditUrl: `https://www.scottbuckley.com.au/library/${track.creditUrl}/`,
})) as MusicTrack[];

export const MOODS = [
  { id: 'all', vi: 'Tất cả', en: 'All sounds' },
  { id: 'piano', vi: 'Piano', en: 'Piano' },
  { id: 'ambient', vi: 'Ambient', en: 'Ambient' },
  { id: 'focus', vi: 'Tập trung sâu', en: 'Deep focus' },
  { id: 'night', vi: 'Học đêm', en: 'Night study' },
  { id: 'calm', vi: 'Nhạc nhẹ', en: 'Calm instrumental' },
] as const;
