"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import {
  Gamepad2,
  Play,
  Swords,
  Zap,
  Trophy,
  Link2,
  Crown,
  Sprout,
  Maximize2,
  Flag as FlagIcon,
  Waves,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { CardBlastModal } from "@/components/features/flashcard/CardBlastModal";
import type { CardBlastModalProps } from "@/components/features/flashcard/card-blast/CardBlastModal";
import type { VocabDeckSummary } from "@/components/features/flashcard/DeckCatalogView";
import { apiClient } from "@/services/api-client";
import { pointerLight } from "@/lib/ui/pointerLight";
import { KingArtwork } from "./king-of-english/KingArtwork";
import { EchoGardenArtwork } from "./echo-garden/EchoGardenArtwork";
import { RushArtwork } from "./echo-quiz-rush/RushArtwork";
import { SpellingArtwork } from "./echo-spelling/SpellingArtwork";
import {
  CardBlastArtwork,
  WordChainArtwork,
  HeroArenaMascotArtwork,
  HangmanArtwork,
} from "./components/GameArtworks";
import styles from "./GamesHub.module.css";

const EMPTY_CARDS: NonNullable<CardBlastModalProps["availableCards"]> = [];
const EMPTY_DECKS: VocabDeckSummary[] = [];

type GameId = "card-blast" | "word-chain" | "king" | "hangman" | "garden" | "rush" | "spelling";

interface GameEntry {
  id: GameId;
  accent: string;
  accent2: string;
  art: ReactNode;
  icon: LucideIcon | null;
  title: string;
  badge: string;
  subtitle: string;
  description: string;
  facts?: { title: string; text: string };
  /** Real entry: a route, the Garden full-screen confirmation, or Card Blast's deck selection + modal. */
  launch: { kind: "link"; href: string; label: string } | { kind: "garden"; label: string } | { kind: "card-blast" };
}

/** Left-to-right order of the arena arc (Card Blast in the middle, as in the approved concept). */
const ARC_ORDER: GameId[] = ["king", "word-chain", "card-blast", "hangman", "garden", "rush", "spelling"];

/**
 * Trò chơi — "Echo Glass" games portal (owner brief 2026-10-20). A night-ocean world under the Echo whale key art; the seven
 * real games stand as dimensional glass cards on an arena arc (every card visible and launchable; the centred one is lifted),
 * with an index of the same seven games underneath. Narrow screens get a swipeable rail of the same cards. Launch rules are the
 * existing ones: explicit deck selection + the original Card Blast modal, the Garden full-screen confirmation, plain routes
 * for the rest. No invented game, mode, filter or statistic.
 */
export function GamesHub() {
  const { locale } = useLanguage();
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pvpCode = searchParams.get("pvp");
  const userScope = (session?.user as { id?: string } | undefined)?.id || session?.user?.email;
  const [deckKey, setDeckKey] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [showGardenLaunchModal, setShowGardenLaunchModal] = useState(false);
  const [active, setActive] = useState<GameId>("card-blast");
  const launchButton = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const vi = locale === "vi";

  const { data: decks = EMPTY_DECKS, error: decksError, isLoading, mutate } = useSWR<VocabDeckSummary[]>(
    userScope ? ["/flashcards/decks", userScope] : null,
    async ([url]: [string, string]) => (await apiClient.get<VocabDeckSummary[]>(url)).data,
    { revalidateOnFocus: false }
  );
  // Empty selection is intentional: never choose a deck on the learner's behalf.
  const selectedDeck = decks.find((deck) => (deck.id != null ? String(deck.id) : deck.slug) === deckKey) || null;
  // Match FlashcardUI's initial library page, including the personal-deck (no deckId) fallback.
  const cardsUrl = selectedDeck
    ? `/flashcards?${selectedDeck.id != null ? `deckId=${selectedDeck.id}&` : ""}page=0&size=50`
    : null;
  const { data: availableCards = EMPTY_CARDS, error: cardsError, isLoading: cardsLoading, mutate: reloadCards } = useSWR(
    cardsUrl && userScope ? [cardsUrl, userScope] : null,
    async ([url]: [string, string]): Promise<typeof EMPTY_CARDS> => {
      const { data } = await apiClient.get(url);
      return Array.isArray(data) ? data : data?.content || data?.data || [];
    },
    { revalidateOnFocus: false, keepPreviousData: false }
  );

  useEffect(() => {
    if (pvpCode) setIsOpen(true);
  }, [pvpCode]);

  const closeGame = () => {
    setIsOpen(false);
    // Remove only the consumed invite; retain other query parameters and hash.
    if (pvpCode) {
      const url = new URL(window.location.href);
      url.searchParams.delete("pvp");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    launchButton.current?.focus();
  };

  const handleConfirmLaunchGarden = async () => {
    setShowGardenLaunchModal(false);
    try {
      if (typeof document !== "undefined") {
        const el = document.documentElement;
        if (el.requestFullscreen) {
          await el.requestFullscreen().catch(() => {});
        } else if (
          (el as unknown as { webkitRequestFullscreen?: () => Promise<void> })
            .webkitRequestFullscreen
        ) {
          await (
            el as unknown as { webkitRequestFullscreen: () => Promise<void> }
          )
            .webkitRequestFullscreen()
            .catch(() => {});
        }
      }
    } catch {
      // Ignore fullscreen rejection; never block entry
    }
    router.push("/games/echo-garden");
  };

  const games: GameEntry[] = [
    {
      id: "card-blast",
      accent: "139 92 246",
      accent2: "59 130 246",
      art: <CardBlastArtwork className="h-full w-full" />,
      icon: Gamepad2,
      title: "Card Blast",
      badge: vi ? "Bắn chữ" : "Typing",
      subtitle: vi ? "Rèn phản xạ gõ từ vựng rơi theo nhịp" : "Typing rhythm and vocabulary defense",
      description: vi
        ? "Gõ từ đang rơi. Giữ thanh máu, tích năng lượng, tung combo."
        : "Catch falling words. Guard your health, charge your skills, unleash a combo.",
      launch: { kind: "card-blast" },
    },
    {
      id: "word-chain",
      accent: "45 212 191",
      accent2: "14 165 233",
      art: <WordChainArtwork className="h-full w-full" />,
      icon: Link2,
      title: "Word Chain",
      badge: vi ? "Nối từ" : "Word linking",
      subtitle: vi ? "Nối chữ cái cuối thành mắt xích từ vựng" : "Link the last letter into an unbreakable chain",
      description: vi
        ? "Chữ cuối mở ra từ tiếp theo. Bạn nối được bao xa?"
        : "Every last letter opens the next word. How far can you go?",
      facts: {
        title: vi ? "Tính năng nổi bật" : "Key Highlights",
        text: vi
          ? "Tra cứu phát âm IPA, nghĩa tiếng Việt, kèm âm thanh chuẩn bản xứ ngay trong trận đấu."
          : "Instant IPA phonetics, Vietnamese meanings, and native audio pronunciation during matches.",
      },
      launch: { kind: "link", href: "/games/word-chain", label: vi ? "Vào Nối từ" : "Play Word Chain" },
    },
    {
      id: "king",
      accent: "251 191 36",
      accent2: "217 119 6",
      art: <KingArtwork className="h-full w-full object-cover" />,
      icon: Crown,
      title: "King Of English",
      badge: vi ? "Vua Tiếng Anh" : "King of English",
      subtitle: vi ? "Từ vựng, cấu trúc và chiến thuật" : "Vocabulary, sentence sense and strategy",
      description: vi
        ? "Bốn thử thách, một vương miện. Mỗi câu trả lời đều kèm lời giải để bạn nhớ lâu hơn."
        : "Four challenges, one crown. Every answer comes with its solution so it sticks.",
      facts: {
        title: vi ? "Bốn chế độ · Tự luyện, Echo, 1v1, phòng riêng" : "Four modes · Solo, Echo, 1v1, private rooms",
        text: vi ? "Phản xạ · Giải nghĩa · Xâu chuỗi · Soán ngôi" : "Reflex · Meaning · Sentence Chain · Crown Conquest",
      },
      launch: { kind: "link", href: "/games/king-of-english", label: vi ? "Vào King Of English" : "Enter King Of English" },
    },
    {
      id: "hangman",
      accent: "56 189 248",
      accent2: "37 99 235",
      art: <HangmanArtwork className="h-full w-full" />,
      icon: null,
      title: "Hangman",
      badge: vi ? "Đoán từ" : "Word Guessing",
      subtitle: vi ? "Đoán chữ, giữ bóng bay, học từ mới" : "Guess letters, save balloons, learn words",
      description: vi ? "Một cuộc phiêu lưu Ocean Storybook với bảng chữ cái A–Z và ba đường độ khó." : "An Ocean Storybook rescue with an A–Z board and three independent difficulty tracks.",
      facts: {
        title: vi ? "Bóng bay là mạng sống" : "Balloons are your lives",
        text: vi ? "Dễ 8 · Vừa 7 · Khó 6. Chữ sai làm nổ đúng một bóng." : "Easy 8 · Medium 7 · Hard 6. Each new wrong letter pops one balloon.",
      },
      launch: { kind: "link", href: "/games/hangman", label: vi ? "Vào Hangman" : "Play Hangman" },
    },
    {
      id: "garden",
      accent: "74 222 128",
      accent2: "16 185 129",
      art: <EchoGardenArtwork className="h-full w-full" />,
      icon: Sprout,
      title: "Echo Garden",
      badge: vi ? "Đảo Ký Ức" : "Memory Island",
      subtitle: vi ? "Nông trại và Cây Tri Thức phản chiếu hành trình học" : "Memory island reflecting your English study milestones",
      description: vi
        ? "Chăm sóc nông sản, gieo Cây Tri Thức từ từ vựng thật, cùng cá voi Echo xây dựng Đảo Ký Ức."
        : "Cultivate crops, nurture Knowledge Trees from real vocabulary, and explore the Memory Island with Echo Whale.",
      facts: {
        title: vi ? "Tính năng nổi bật" : "Key Highlights",
        text: vi
          ? "Đảo 2.5D lơ lửng, Cây Tri Thức gắn từ vựng, Sâu Quên Lãng ôn cứu hộ, cá voi Echo bơi lội."
          : "Floating 2.5D island, Knowledge Trees tied to flashcards, review pests, and swimming Echo Whale.",
      },
      launch: { kind: "garden", label: vi ? "Vào Echo Garden" : "Play Echo Garden" },
    },
    {
      id: "rush",
      accent: "129 140 248",
      accent2: "45 212 191",
      art: <RushArtwork />,
      icon: FlagIcon,
      title: "Echo Quiz Rush",
      badge: vi ? "Đường đua" : "Quiz Race",
      subtitle: vi ? "Đường đua tri thức trên mây" : "A knowledge race above the clouds",
      description: vi
        ? "Chạy tới cổng đáp án đúng, tăng tốc và khám phá con đường cùng Echo."
        : "Run to the right answer gate, build speed and explore the causeway with Echo.",
      facts: {
        title: vi ? "Tính năng nổi bật" : "Key Highlights",
        text: vi
          ? "Đua tốc độ trả lời trên mây · Solo Practice · Sprint · Dash · Echo Rush."
          : "Speed quiz racing above the clouds · Solo Practice · Sprint · Dash · Echo Rush.",
      },
      launch: { kind: "link", href: "/games/echo-quiz-rush", label: vi ? "Vào Echo Quiz Rush" : "Play Echo Quiz Rush" },
    },
    {
      id: "spelling",
      accent: "125 211 252",
      accent2: "196 154 237",
      art: <SpellingArtwork />,
      icon: Trophy,
      title: "Echo Spelling",
      badge: vi ? "Đánh vần" : "Spelling",
      subtitle: vi ? "Lắng nghe. Tự tin tỏa sáng." : "Listen closely. Own the stage.",
      description: vi ? "Bước lên sân khấu đại dương, nghe giọng Echo và chinh phục từng con chữ." : "Take the ocean stage, listen to Echo and make every letter count.",
      facts: { title: vi ? "Sân khấu của bạn" : "Your stage", text: vi ? "Solo Sinh tồn · Nước rút · Luyện tập · Thi đấu 2–10 người." : "Solo Endless · Sprint · Practice · Competition for 2–10 players." },
      launch: { kind: "link", href: "/games/echo-spelling", label: vi ? "Vào Echo Spelling" : "Play Echo Spelling" },
    },
  ];
  const byId = (id: GameId) => games.find((g) => g.id === id)!;
  const activeArc = ARC_ORDER.indexOf(active);

  // The narrow rail really scrolls; on the arc a card's edge may only overhang the stage, which is not a rail.
  const isRail = () => {
    const el = stageRef.current;
    return !!el && getComputedStyle(el).overflowX !== "visible" && el.scrollWidth > el.clientWidth + 4;
  };
  const focusGame = useCallback((id: GameId) => {
    setActive(id);
    const el = stageRef.current;
    // In the narrow rail the cards scroll; bring the chosen one into view there (the arc needs no scrolling).
    if (el && getComputedStyle(el).overflowX !== "visible" && el.scrollWidth > el.clientWidth + 4) {
      el.querySelector<HTMLElement>(`[data-game="${id}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, []);
  const step = (delta: number) => focusGame(ARC_ORDER[(activeArc + delta + ARC_ORDER.length) % ARC_ORDER.length]);
  const onStageKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "SELECT" || tag === "INPUT") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };
  // A click on a card's picture or text (never on its controls) brings it to the centre of the arc.
  const onCardClick = (id: GameId) => (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a, button, select, label")) return;
    if (id !== active && !isRail()) setActive(id);
  };

  const statusText = decksError || cardsError
    ? (vi ? "Chưa tải được bộ từ. Vui lòng thử lại." : "Could not load your deck. Please retry.")
    : isLoading || cardsLoading
      ? (vi ? "Đang tải bộ từ…" : "Loading your deck…")
      : decks.length === 0
        ? (vi ? "Chưa có bộ từ. Thêm từ trong Thẻ từ vựng để bắt đầu." : "No decks yet. Add vocabulary in Flashcards to get started.")
        : (vi ? "Tùy chỉnh tốc độ rơi, độ khó và chế độ đối kháng bên trong game." : "Configure speed, hints, and duel modes inside the game.");

  const renderLaunch = (game: GameEntry) => {
    if (game.launch.kind === "card-blast") {
      return (
        <div className={styles.deckBox}>
          <label htmlFor="card-blast-deck" className={styles.deckLabel}>
            {vi ? "Chọn bộ từ để xuất trận" : "Select vocabulary deck"}
          </label>
          <select
            id="card-blast-deck"
            value={deckKey}
            onChange={(event) => setDeckKey(event.target.value)}
            disabled={isLoading || !!decksError}
            aria-describedby="card-blast-launch-status"
            className={styles.deckSelect}
          >
            <option value="">{vi ? "— Chọn bộ từ để chơi —" : "— Choose a deck to play —"}</option>
            {decks.map((deck) => {
              const key = deck.id != null ? String(deck.id) : deck.slug;
              const rawCount = deck.totalWords ?? (deck as any).totalCards;
              const countText = typeof rawCount === "number" ? ` (${rawCount} ${vi ? "từ" : "cards"})` : "";
              return (
                <option key={key} value={key}>
                  {deck.title}{countText}
                </option>
              );
            })}
          </select>
          <p id="card-blast-launch-status" role="status" className={styles.deckStatus}>{statusText}</p>
          {(decksError || cardsError) && (
            <button type="button" className={styles.retry} onClick={() => { void mutate(); void reloadCards(); }}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {vi ? "Thử lại" : "Retry"}
            </button>
          )}
          <button
            ref={launchButton}
            type="button"
            className={styles.cta}
            data-guide="gh-play"
            disabled={!selectedDeck || cardsLoading || !!cardsError || !!decksError}
            onClick={() => setIsOpen(true)}
          >
            <Play className="h-[18px] w-[18px] fill-current" aria-hidden="true" />
            <span>{vi ? "Vào Card Blast" : "Play Card Blast"}</span>
          </button>
        </div>
      );
    }
    if (game.launch.kind === "garden") {
      return (
        <button
          type="button"
          data-testid="echo-garden-launch-btn"
          data-guide="gh-play"
          onClick={() => setShowGardenLaunchModal(true)}
          className={styles.cta}
        >
          <Play className="h-[18px] w-[18px] fill-current" aria-hidden="true" />
          <span>{game.launch.label}</span>
        </button>
      );
    }
    return (
      <Link href={game.launch.href} className={styles.cta} data-guide="gh-play">
        <Play className="h-[18px] w-[18px] fill-current" aria-hidden="true" />
        <span>{game.launch.label}</span>
      </Link>
    );
  };

  return (
    <div className={styles.world}>
      {/* The scene: night ocean (dark) / lagoon sky (light), the Echo whale key art, drifting crystals, a lit water floor. */}
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.sky} />
        <HeroArenaMascotArtwork className={styles.whale} />
        <div className={styles.aurora}><i /><i /></div>
        <div className={styles.crystals}><i /><i /><i /><i /><i /></div>
        <div className={styles.floor}><i /><i /><i /></div>
      </div>

      <div className={styles.inner}>
        <header className={styles.hero}>
          <span className={styles.kicker}>
            <Swords className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{vi ? "Đấu trường từ vựng trực tuyến" : "Live Vocabulary Arena"}</span>
          </span>
          <h1 className={styles.title}>{vi ? "Thư viện trò chơi" : "Games Library"}</h1>
          <p className={styles.lead}>
            {vi
              ? "Cùng Echo chinh phục những mảnh ghép từ vựng và combo tư duy."
              : "Conquer vocabulary fragments and strategic combos with Echo."}
          </p>
          {/* Exactly three approved feature pills */}
          <div className={styles.pills}>
            <span className={styles.pill} data-tone="amber">
              <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{vi ? "Rèn phản xạ từ vựng" : "Reflex Training"}</span>
            </span>
            <span className={styles.pill} data-tone="sky">
              <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{vi ? "Chinh phục nhiều chế độ" : "Diverse Game Modes"}</span>
            </span>
            <span className={styles.pill} data-tone="teal">
              <Waves className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{vi ? "Đồng hành cùng Echo" : "Journey with Echo"}</span>
            </span>
          </div>
        </header>

        {/* Games Arena Library */}
        <section aria-labelledby="games-arena-title" className={styles.arena}>
          <div
            ref={stageRef}
            className={styles.stage}
            data-spatial-owner="carousel"
            role="group"
            aria-roledescription={vi ? "sân khấu trò chơi" : "game stage"}
            aria-label={vi ? "Bảy trò chơi" : "Seven games"}
            onKeyDown={onStageKey}
          >
            {games.map((game) => {
              const ring = ARC_ORDER.indexOf(game.id);
              const offset = wrap(ring - activeArc, ARC_ORDER.length);
              const distance = Math.abs(offset);
              const [x, y, turn, tilt, scale] = SLOTS[Math.min(distance, 3)];
              const Icon = game.icon;
              return (
                <article
                  key={game.id}
                  data-game={game.id}
                  data-offset={offset}
                  aria-label={game.title}
                  className={styles.card}
                  onClick={onCardClick(game.id)}
                  style={{
                    "--a": game.accent,
                    "--a2": game.accent2,
                    "--x": Math.sign(offset) * x,
                    "--y": `${y}rem`,
                    "--turn": `${-Math.sign(offset) * turn}deg`,
                    "--tilt": `${Math.sign(offset) * tilt}deg`,
                    "--s": scale,
                    zIndex: 10 - distance,
                  } as CSSProperties}
                  {...pointerLight}
                >
                  <span className={styles.cardRim} aria-hidden="true" />
                  <span className={styles.cardSheen} aria-hidden="true" />
                  <div className={styles.art}>
                    {game.art}
                    <span className={styles.artTag}>
                      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : <b aria-hidden="true">A</b>}
                      <span>{game.badge}</span>
                    </span>
                  </div>
                  <div className={styles.body}>
                    <div className={styles.head}>
                      <span className={styles.icon} aria-hidden="true">
                        {Icon ? <Icon className="h-5 w-5" /> : <span className="text-lg font-black">A</span>}
                      </span>
                      <div className="min-w-0">
                        <h3 className={styles.gameTitle}>{game.title}</h3>
                        <p className={styles.subtitle}>{game.subtitle}</p>
                      </div>
                    </div>
                    <p className={styles.description} data-compact={game.launch.kind === "card-blast" || undefined}>{game.description}</p>
                    {game.facts && (
                      <p className={styles.facts}>
                        <strong>{game.facts.title}</strong>
                        <span>{game.facts.text}</span>
                      </p>
                    )}
                    <div className={styles.launch}>{renderLaunch(game)}</div>
                  </div>
                </article>
              );
            })}
          </div>

          <div className={styles.dock}>
            <div className={`${styles.dockTitle} ec-wp-plate`}>
              <span className={styles.dockIcon} aria-hidden="true"><Gamepad2 className="h-5 w-5" /></span>
              <div className="min-w-0">
                <h2 id="games-arena-title" className={styles.dockHeading}>{vi ? "CHỌN TRÒ CHƠI" : "CHOOSE A GAME"}</h2>
                <p className={styles.dockLead}>{vi ? "Bảy trò chơi học tiếng Anh, chọn một để xem gần hơn." : "Seven English games: pick one to bring it forward."}</p>
              </div>
            </div>
            <div className={styles.index}>
              <button type="button" className={styles.navBtn} onClick={() => step(-1)} aria-label={vi ? "Trò chơi trước" : "Previous game"}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <ul className={styles.chips}>
                {ARC_ORDER.map((id) => {
                  const g = byId(id);
                  const Icon = g.icon;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={styles.chip}
                        aria-pressed={id === active}
                        style={{ "--a": g.accent } as CSSProperties}
                        onClick={() => focusGame(id)}
                      >
                        {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : <b aria-hidden="true">A</b>}
                        <span>{g.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button type="button" className={styles.navBtn} onClick={() => step(1)} data-guide="gh-next" aria-label={vi ? "Trò chơi tiếp theo" : "Next game"}>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      </div>

      <CardBlastModal
        isOpen={isOpen}
        onClose={closeGame}
        deck={selectedDeck}
        availableCards={availableCards}
        allDecks={decks}
        initialPvpCode={pvpCode || undefined}
      />

      {/* Echo Garden Full-Screen Launch Confirmation Modal */}
      {showGardenLaunchModal && (
        <div role="presentation" className={styles.modalScrim}>
          <div role="dialog" aria-modal="true" aria-labelledby="garden-modal-title" className={styles.modal}>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/15 text-emerald-300">
                <Sprout className="h-6 w-6" />
              </div>
              <div>
                <h2 id="garden-modal-title" className="text-xl font-black tracking-tight text-white">
                  {vi ? "Vào Đảo Ký Ức?" : "Enter Memory Island?"}
                </h2>
                <p className="mt-0.5 text-xs text-slate-300">
                  {vi ? "Chế độ trò chơi toàn màn hình" : "Full-screen standalone game mode"}
                </p>
              </div>
            </div>

            <ul className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs text-slate-200 sm:text-sm">
              <li className="flex items-start gap-2.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <span className="leading-relaxed">
                  {vi ? "Echo Garden mở trong chế độ toàn màn hình trò chơi (Full-screen game mode)." : "Echo Garden opens in full-screen game mode."}
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <span className="leading-relaxed">
                  {vi ? "Toàn bộ thanh điều hướng EnglishCoach sẽ được ẩn trong khi chơi để tập trung tối đa." : "EnglishCoach navigation will be hidden during play for complete immersion."}
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <span className="leading-relaxed">
                  {vi ? "Người chơi có thể nhấn 'Thoát' bất kỳ lúc nào để quay lại Thư viện trò chơi." : "The player can exit at any time and return to the Games Hub."}
                </span>
              </li>
            </ul>

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowGardenLaunchModal(false)}
                className="cursor-pointer rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold text-slate-100 transition-colors hover:bg-white/10 sm:text-sm"
              >
                {vi ? "Hủy" : "Cancel"}
              </button>
              <button
                type="button"
                data-testid="confirm-enter-fullscreen-btn"
                onClick={handleConfirmLaunchGarden}
                className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-500/25 transition-all hover:brightness-110 active:scale-95 sm:text-sm"
              >
                <Maximize2 className="h-4 w-4" />
                <span>{vi ? "Vào toàn màn hình" : "Enter Full Screen"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Arc geometry per distance from the centre: x (share of the stage width), drop (rem), turn (deg), lean (deg), scale.
const SLOTS = [[0, 0, 0, 0, 1.28], [19.5, 1.4, 15, 2.5, 1], [35, 3, 21, 5, 0.88], [48, 4.4, 25, 7, 0.78]] as const;

// Offset of a card from the centred one; with seven games the arc is balanced (−3 … +3).
function wrap(value: number, count: number) { const half = Math.floor((count - 1) / 2); return ((value + half) % count + count) % count - half; }
