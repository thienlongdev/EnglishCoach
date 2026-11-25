/*
 * Deck artwork of the "Echo Memory Universe" library (2026-10-24): rendered stills of scenes built in code (Blender, CPU;
 * `docs/flashcards/memory-universe-2026-10-24/art/`). Each picture shows its own deck's topic, chosen from the deck's title
 * and description in the catalog; a deck that is not listed here has no picture (a typographic cover is shown instead —
 * never another deck's art). Content-hashed names: a changed picture ships under a new name (the edge caches images for a
 * year). Decorative: rendered with alt="" and aria-hidden.
 */
import bookImages from "./bookArt.json";

export interface DeckArt {
  small: string;
  large: string;
  largeWidth?: number;
}

const A = "/assets/flashcards/";
const art = (small: string, large: string): DeckArt => ({ small: A + small, large: A + large });

/** Catalog slug → picture. Slugs come from `backend/src/main/resources/data/decks/*.json`. */
const BY_SLUG: Record<string, DeckArt> = {
  personal: art("deck-personal-640-c4026be2.webp", "deck-personal-1280-9b3c5169.webp"),
  "ielts-environment": art("deck-environment-640-a15da6b6.webp", "deck-environment-1280-adfe8c35.webp"),
  "ielts-technology": art("deck-technology-640-498a430f.webp", "deck-technology-1280-05ee5db8.webp"),
  "ielts-education": art("deck-education-640-ed77828f.webp", "deck-education-1280-95ea07b3.webp"),
  "ielts-business": art("deck-business-640-1f0d2263.webp", "deck-business-1280-dd4a6907.webp"),
  "ielts-health": art("deck-health-640-e07f1e7d.webp", "deck-health-1280-2ed00d38.webp"),
  "ielts-society-culture": art("deck-culture-640-7e0cae2b.webp", "deck-culture-1280-92bdc027.webp"),
  "ielts-urban-tourism": art("deck-urban-640-df98665c.webp", "deck-urban-1280-131c7dff.webp"),
  "ielts-science": art("deck-science-640-a4ff0913.webp", "deck-science-1280-44754876.webp"),
  "ielts-phrasal-verbs": art("deck-phrasal-640-17a52aef.webp", "deck-phrasal-1280-6c76bb68.webp"),
  "ielts-collocations": art("deck-collocations-640-9b0cf6ed.webp", "deck-collocations-1280-7a9511ad.webp"),
  "oxford-3000-core": art("deck-oxford3000-640-2f8c8e99.webp", "deck-oxford3000-1280-95799fbc.webp"),
  "oxford-5000-advanced": art("deck-oxford5000-640-b7c327d2.webp", "deck-oxford5000-1280-9d283f32.webp"),
  "4k-essential-book-1": art("deck-book1-640-7599f067.webp", "deck-book1-1280-5f5fbea7.webp"),
  "4k-essential-book-2": art("deck-book2-640-3a2b7264.webp", "deck-book2-1280-1ef731f6.webp"),
  "4k-essential-book-3": art("deck-book3-640-b1b875d0.webp", "deck-book3-1280-37d908b2.webp"),
  "4k-essential-book-4": art("deck-book4-640-436ebfa9.webp", "deck-book4-1280-cf0a9f09.webp"),
  "4k-essential-book-5": art("deck-book5-640-e307c16e.webp", "deck-book5-1280-ec8f69ec.webp"),
  "4k-essential-book-6": art("deck-book6-640-9c433d59.webp", "deck-book6-1280-205dfd76.webp"),
  // SYSTEM topic decks (2026-10-30): one subject per topic in the same world
  // (`docs/flashcards/vocabulary-universe-2026-10-30/art/scene_topic.py` → `export_webp.py`)
  "topic-food-cooking": art("deck-food-cooking-640-7f8fc335.webp", "deck-food-cooking-1280-44eae264.webp"),
  "topic-body-health": art("deck-body-health-640-e360122e.webp", "deck-body-health-1280-e2560f5d.webp"),
  "topic-animals": art("deck-animals-640-203c2221.webp", "deck-animals-1280-e3d7d291.webp"),
  "topic-nature-weather": art("deck-nature-weather-640-8dd2a70e.webp", "deck-nature-weather-1280-a5aaa1ee.webp"),
  "topic-space": art("deck-space-640-e832ca1f.webp", "deck-space-1280-4eab251e.webp"),
  "topic-family-relationships": art("deck-family-relationships-640-a82755eb.webp", "deck-family-relationships-1280-91ea24fe.webp"),
  "topic-jobs-workplace": art("deck-jobs-workplace-640-0cc17b1c.webp", "deck-jobs-workplace-1280-cecd9a16.webp"),
  "topic-home-household": art("deck-home-household-640-9fe85920.webp", "deck-home-household-1280-d7cae4ed.webp"),
  "topic-clothing-fashion": art("deck-clothing-fashion-640-f8fe587e.webp", "deck-clothing-fashion-1280-9d454189.webp"),
  "topic-transport-travel": art("deck-transport-travel-640-fcfab4c7.webp", "deck-transport-travel-1280-f631159d.webp"),
  "topic-city-places": art("deck-city-places-640-34c66b47.webp", "deck-city-places-1280-94f6e930.webp"),
  "topic-emotions-feelings": art("deck-emotions-feelings-640-e7b9a409.webp", "deck-emotions-feelings-1280-732bcc91.webp"),
  "topic-personality": art("deck-personality-640-c4af8e8e.webp", "deck-personality-1280-0425ec96.webp"),
  "topic-sports-leisure": art("deck-sports-leisure-640-0e8f3dad.webp", "deck-sports-leisure-1280-e8d0fc2a.webp"),
  "topic-music-arts": art("deck-music-arts-640-4f26c292.webp", "deck-music-arts-1280-b9cf614b.webp"),
  "topic-school-learning": art("deck-school-learning-640-aebfba36.webp", "deck-school-learning-1280-2374850e.webp"),
  "topic-time-calendar": art("deck-time-calendar-640-e50e9d5d.webp", "deck-time-calendar-1280-c9217fca.webp"),
  "topic-money-shopping": art("deck-money-shopping-640-8e298f58.webp", "deck-money-shopping-1280-6f3f83da.webp"),
  "topic-communication": art("deck-communication-640-a6143c88.webp", "deck-communication-1280-80a2374a.webp"),
  "topic-technology-devices": art("deck-technology-devices-640-bbd9671f.webp", "deck-technology-devices-1280-f5975303.webp"),
  "topic-everyday-verbs": art("deck-everyday-verbs-640-ff4cadda.webp", "deck-everyday-verbs-1280-c6c1e820.webp"),
  "topic-thinking-ideas": art("deck-thinking-ideas-640-8100e643.webp", "deck-thinking-ideas-1280-ae0eabca.webp"),
  "topic-society-law": art("deck-society-law-640-f179b7f8.webp", "deck-society-law-1280-9884ff00.webp"),
  "topic-numbers-measures": art("deck-numbers-measures-640-6c928117.webp", "deck-numbers-measures-1280-346fd863.webp"),
  "topic-describing-words": art("deck-describing-words-640-e70fe0c5.webp", "deck-describing-words-1280-5a67b97e.webp"),
  "topic-adverbs-connectors": art("deck-adverbs-connectors-640-9a3f88e4.webp", "deck-adverbs-connectors-1280-f6cca6dd.webp"),
  // TOEIC & IELTS score-banded decks (2026-11-19): progressive 3D Echo Memory Universe sculptures
  // (`docs/flashcards/exam-score-library-2026-11-19/art/scene_exam_score.py`)
  "toeic-score-foundation": art("deck-toeic-score-foundation-640-ce15da60.webp", "deck-toeic-score-foundation-1280-041aa62f.webp"),
  "toeic-score-elementary": art("deck-toeic-score-elementary-640-78f891e7.webp", "deck-toeic-score-elementary-1280-5a97197b.webp"),
  "toeic-score-intermediate": art("deck-toeic-score-intermediate-640-7a060bc7.webp", "deck-toeic-score-intermediate-1280-d5f84247.webp"),
  "toeic-score-upper-intermediate": art("deck-toeic-score-upper-intermediate-640-05f88d1a.webp", "deck-toeic-score-upper-intermediate-1280-7c72de75.webp"),
  "toeic-score-advanced": art("deck-toeic-score-advanced-640-4b9f5d23.webp", "deck-toeic-score-advanced-1280-2935b6fc.webp"),
  "ielts-band-developing": art("deck-ielts-band-developing-640-086be33d.webp", "deck-ielts-band-developing-1280-21ca58c9.webp"),
  "ielts-band-competent": art("deck-ielts-band-competent-640-a608f1a3.webp", "deck-ielts-band-competent-1280-f5bf02cf.webp"),
  "ielts-band-advanced": art("deck-ielts-band-advanced-640-d7d9cf81.webp", "deck-ielts-band-advanced-1280-be676383.webp"),
  "ielts-band-expert": art("deck-ielts-band-expert-640-b9cb7d20.webp", "deck-ielts-band-expert-1280-6e74e9a7.webp"),
};

export function deckArtFor(slug: string): DeckArt | null {
  const id = /^bk-([a-f0-9]{12})-/.exec(slug)?.[1];
  if (id) {
    const image = (bookImages as Record<string, string[]>)[id];
    return image ? { ...art(image[0], image[1]), largeWidth: 1120 } : null;
  }
  return BY_SLUG[slug] ?? null;
}

/**
 * Hero: Echo — the real English Coach whale model in its own paint — rising out of an evening ocean through a spiral of
 * glass flashcards. A 4.8 : 1 panorama that covers the hero anchored right (calm sky behind the text).
 */
export const FLASHCARD_HERO_ART: DeckArt = art("flashcards-hero-1920-5b431f7f.webp", "flashcards-hero-3840-2130a571.webp");
