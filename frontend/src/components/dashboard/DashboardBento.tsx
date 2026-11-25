"use client";

import React from "react";
import Link from "next/link";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/context/LanguageContext";
import { useUnifiedStreak } from "@/hooks/useUnifiedStreak";
import { useModuleEntryResource } from "@/hooks/useModuleEntryResource";
import { READING_ENTRY_PATH, LISTENING_MATERIALS_ENTRY_PATH } from "@/services/moduleEntryResources";
import {
  Layers,
  BookOpen,
  Headphones,
  Mic,
  PenTool,
  ClipboardList,
  ArrowRight,
  ArrowUpRight,
  Compass,
  Activity,
  Clock3,
  type LucideIcon,
} from "lucide-react";

import { estimateReviewMinutes } from "@/utils/dashboardUtils";
import { pointerLight } from "@/lib/ui/pointerLight";
import { ContentDiscoveryHub } from "./ContentDiscoveryHub";
import { LeaderboardWidget } from "@/components/features/leaderboard/LeaderboardWidget";
import { authFetch } from "@/lib/api-session";
import { TopLearnersWidget } from "@/components/features/leaderboard/TopLearnersWidget";
import styles from "./dashboard.module.css";
import { DashboardSectionHeader } from "./DashboardSectionHeader";
import { DashboardHeroScene } from "./DashboardHeroScene";
import { StreakFlame } from "./StreakFlame";
import { GatewayEmblem } from "./GatewayEmblems";
import { echoSrc } from '@/lib/brand/echoCharacters';
import MilestoneEffect from '@/components/vfx/MilestoneEffect';
import { ReleaseAnnouncement } from '@/components/echoAnywhere/ReleaseAnnouncement';

interface DashboardBentoProps {
  userName?: string | null;
  onNavigate: (tab: string) => void;
}

// ─── API fetcher: the browser's session cookie authenticates; the page holds no token ───
const authFetcher = async (url: string) => {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";
    const res = await authFetch(`${baseUrl}${url}`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

type ModuleId = "flashcards" | "reading" | "listening" | "speaking" | "writing" | "exams";
type Tone = "indigo" | "emerald" | "amber" | "rose" | "sky" | "violet";

interface ModuleEntry {
  id: ModuleId;
  tone: Tone;
  icon: LucideIcon;
  badge: string;
  title: string;
  text: string;
  metric: string;
  cta: string;
}

/**
 * Trang chủ — "Echo Glass" (owner brief 2026-10-20). A cinematic hero scene (night ocean / dawn ocean) with the real
 * learning metrics on signature glass, six dimensional learning gateways, the weekly podium beside today's real content.
 * Every number, label and destination is the same server data and route as before; nothing is invented.
 */
export function DashboardBento({ userName, onNavigate }: DashboardBentoProps) {
  const { locale } = useLanguage();
  const vi = locale === "vi";
  const { data: session } = useSession();

  const userEmail = session?.user?.email;

  // Clean dynamic user display name without student codes, class codes, or technical emails
  const rawName = userName || session?.user?.name;
  const cleanName = React.useMemo(() => {
    if (!rawName) return "";
    let cleaned = rawName.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").trim();
    if (!cleaned) return "";
    // Strip student/class code prefixes like "B24DCCN370 - "
    cleaned = cleaned.replace(/^[A-Za-z0-9_]{3,15}\s*[-–—:]\s*/, "").trim();
    if (cleaned.includes(" - ")) {
      const parts = cleaned.split(" - ");
      cleaned = parts[parts.length - 1].trim();
    }
    if (cleaned.includes("@")) {
      cleaned = cleaned.split("@")[0].trim();
    }
    // Extract given name for Vietnamese multi-part names (e.g. "Nguyễn Tú Thiên Long" -> "Thiên Long")
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
      return `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
    } else if (tokens.length > 0) {
      return tokens.join(" ");
    }
    return cleaned;
  }, [rawName]);

  // No name on the account ⇒ a neutral address (never somebody else's name).
  const welcomeText = cleanName
    ? (vi ? `Chào mừng trở lại, ${cleanName}` : `Welcome back, ${cleanName}`)
    : (vi ? "Chào mừng bạn trở lại" : "Welcome back");

  // ─── Real Cross-Module Data Ingestion ───────────────────────────────────────
  // 1. Due Flashcards (Authorized & user-scoped with dailyReviewLimit cap)
  const { data: dueCardsData } = useSWR(
    userEmail ? ["/flashcards/due-count?limit=20", userEmail] : null,
    async ([url]) => {
      try {
        const res = await authFetcher(url);
        if (res) return res;
      } catch {}
      return authFetcher("/flashcards/due?page=0&size=1");
    },
    { revalidateOnFocus: true, dedupingInterval: 5000, keepPreviousData: true }
  );
  const dueLoading = dueCardsData === undefined;
  const rawDueCount = typeof dueCardsData?.dueCount === "number"
    ? dueCardsData.dueCount
    : (typeof dueCardsData?.totalElements === "number" ? dueCardsData.totalElements : 0);
  const dueCount = Math.min(20, rawDueCount);

  // 2. Real Unified Streak Source across all 10 learning modules (Phase B)
  const { streak: unifiedStreak, isLoading: streakLoading } = useUnifiedStreak();
  const currentStreakDays = unifiedStreak?.currentStreakDays ?? 0;
  // Same 10-day scale as before (10 % per day, full at 10 days): drawn as a ring instead of a bar.
  const streakFill = currentStreakDays > 0 ? Math.min(currentStreakDays * 10, 100) : 0;

  // 3. Reading Materials (User-Scoped Catalog)
  const reading = useModuleEntryResource(READING_ENTRY_PATH);
  const readingCount = (reading.data as { totalElements?: number } | undefined)?.totalElements;

  // 4. Listening Materials (User-Scoped Catalog)
  const listening = useModuleEntryResource(LISTENING_MATERIALS_ENTRY_PATH);
  const listeningCount = Array.isArray(listening.data) ? listening.data.length : undefined;

  // 5. Writing Sessions (Active Drafts, Authorized)
  const { data: writingSessions } = useSWR(
    userEmail ? ["/writing/sessions?completed=false", userEmail] : null,
    ([url]) => authFetcher(url),
    { revalidateOnFocus: false, dedupingInterval: 60000, keepPreviousData: true }
  );
  const writingDraftsCount = Array.isArray(writingSessions) ? writingSessions.length : 0;

  const reviewMinutes = estimateReviewMinutes(dueCount);
  const reviewSessionText = vi ? `Phiên ôn hôm nay: ${reviewMinutes} phút` : `Today's session: ${reviewMinutes} mins`;

  const modules: ModuleEntry[] = [
    {
      id: "flashcards",
      tone: "indigo",
      icon: Layers,
      badge: vi ? "Ôn tập ngắt quãng" : "Spaced review",
      title: vi ? "Flashcards thông minh" : "Smart Flashcards",
      text: vi
        ? "Ghi nhớ từ vựng lâu dài với lịch ôn tập ngắt quãng: thẻ đến hạn được nhắc lại đúng lúc để bạn không quên."
        : "Keep vocabulary for good with spaced review: due cards come back at the right moment so they stick.",
      metric: dueLoading ? (vi ? "Đang tải lịch ôn…" : "Loading your reviews…") : reviewSessionText,
      cta: vi ? "Vào Flashcards" : "Open Flashcards",
    },
    {
      id: "reading",
      tone: "emerald",
      icon: BookOpen,
      badge: vi ? "Báo chí quốc tế" : "World news",
      title: vi ? "Luyện đọc chuyên sâu" : "Deep Reading",
      text: vi
        ? "Đọc bài từ The Guardian, BBC và thư viện tuyển chọn, tra từ chỉ với một chạm và giải nghĩa theo ngữ cảnh."
        : "Read pieces from The Guardian, the BBC and the curated library, with one-tap lookup and in-context explanations.",
      metric: readingCount !== undefined
        ? (vi ? `${readingCount} bài đọc trong thư viện` : `${readingCount} articles in the library`)
        : reading.error
          ? (vi ? "Thư viện đọc tuyển chọn" : "Curated reading library")
          : (vi ? "Đang tải thư viện đọc…" : "Loading the reading library…"),
      cta: vi ? "Mở Reading" : "Open Reading",
    },
    {
      id: "listening",
      tone: "amber",
      icon: Headphones,
      badge: "Dictation and Audio",
      title: vi ? "Luyện nghe chủ động" : "Active Listening",
      text: vi
        ? "Nghe với transcript tương tác, chép chính tả từng câu và luyện nối âm, nuốt âm như người bản xứ."
        : "Listen with an interactive transcript, take sentence-by-sentence dictation and train linking and reduced sounds.",
      metric: listeningCount !== undefined
        ? (vi ? `${listeningCount} bài nghe đa giọng điệu` : `${listeningCount} listening lessons`)
        : listening.error
          ? (vi ? "Thư viện bài nghe tương tác" : "Interactive listening library")
          : (vi ? "Đang tải thư viện nghe…" : "Loading the listening library…"),
      cta: vi ? "Luyện Listening" : "Practise Listening",
    },
    {
      id: "speaking",
      tone: "rose",
      icon: Mic,
      badge: vi ? "Luyện nói với AI" : "Speak with AI",
      title: vi ? "Luyện nói cùng AI" : "Speaking with AI",
      text: vi
        ? "Hội thoại nhập vai với AI, luyện shadowing, nhận phản hồi phát âm và luyện nói theo chủ đề không cần AI."
        : "Role-play conversations with AI, shadowing, pronunciation feedback and AI-free topic speaking practice.",
      metric: vi ? "Shadowing và Roleplay tương tác" : "Interactive shadowing and role-play",
      cta: vi ? "Bắt đầu nói" : "Start speaking",
    },
    {
      id: "writing",
      tone: "sky",
      icon: PenTool,
      badge: "AI Essay Feedback",
      title: vi ? "Luyện viết và sửa lỗi" : "Writing and Corrections",
      text: vi
        ? "Thực hành viết bài luận và email, luyện câu, luyện gõ và dịch; AI nhận xét chi tiết theo 4 tiêu chí chấm bài."
        : "Practise essays and emails, sentences, typing and translation; AI gives detailed feedback on four criteria.",
      metric: writingDraftsCount > 0
        ? (vi ? `${writingDraftsCount} bài nháp đang lưu` : `${writingDraftsCount} saved drafts`)
        : (vi ? "Chấm điểm chuẩn 4 tiêu chí" : "Four-criteria feedback"),
      cta: vi ? "Vào Writing" : "Open Writing",
    },
    {
      id: "exams",
      tone: "violet",
      icon: ClipboardList,
      badge: vi ? "Thi thử chuẩn hóa" : "Mock exams",
      title: vi ? "Thi thử và đánh giá" : "Mock Exams and Assessment",
      text: vi
        ? "Luyện đề theo định dạng IELTS và TOEIC Listening và Reading: thi đầy đủ có tính giờ hoặc luyện riêng từng phần."
        : "Practise in the IELTS and TOEIC Listening and Reading formats: timed full tests or one part at a time.",
      metric: vi ? "Thi đầy đủ hoặc luyện theo phần" : "Full tests or practice by part",
      cta: vi ? "Vào phòng thi" : "Enter the exam room",
    },
  ];

  return (
    <div className={`${styles.page} font-sans antialiased`}>
      <MilestoneEffect kind="streak" value={unifiedStreak?.currentStreakDays} />
      <ReleaseAnnouncement vi={vi} />
      {/* ─── SECTION 1: WELCOME + LEARNING METRICS (signature glass over the hero scene) ─────────────── */}
      <section
        className={styles.hero}
        data-purpose="flagship-hero"
        aria-labelledby="dashboard-hero-title"
        {...pointerLight}
      >
        <DashboardHeroScene />

        <div className={styles.heroGrid}>
          {/* Welcome, headline, actions */}
          <div className={styles.heroCopy}>
            <span className={styles.greeting}>
              <span className={styles.greetingMark}>
                <img
                  src={echoSrc('official', 40)}
                  alt="Echo Whale"
                  className="h-4 w-4 shrink-0 select-none object-contain pointer-events-none"
                />
              </span>
              <span>{welcomeText}</span>
            </span>

            <h1 id="dashboard-hero-title" className={styles.headline}>
              <span className="block">{vi ? "Bứt phá giới hạn tiếng Anh," : "Break through your English limits,"}</span>
              <span className={styles.headlineAccent}>{vi ? "ngay hôm nay" : "starting today"}</span>
            </h1>

            <p className={styles.lead}>
              {vi
                ? "Tăng tốc vốn từ vựng với thẻ học, luyện phản xạ Speaking cùng AI và làm chủ bài viết nghị luận."
                : "Accelerate vocabulary with flashcards, sharpen Speaking reflexes with AI, and master argumentative writing."}
            </p>

            <div className={styles.heroActions}>
              <Link
                href="/learning-path"
                prefetch={false}
                id="hero-explore-roadmap-btn"
                className={styles.ctaPrimary}
              >
                <span className={styles.ctaIcon} aria-hidden="true"><Compass className="h-[17px] w-[17px]" /></span>
                <span>{vi ? "Khám phá lộ trình" : "Explore Roadmap"}</span>
                <ArrowRight className={styles.ctaArrow} aria-hidden="true" />
              </Link>
              {!dueLoading && dueCount > 0 && (
                <button
                  type="button"
                  data-testid="hero-review-due"
                  onClick={() => onNavigate("flashcards")}
                  className={styles.ctaGhost}
                >
                  <Layers className="h-[17px] w-[17px]" aria-hidden="true" />
                  <span>{vi ? `Ôn ${dueCount} thẻ đến hạn` : `Review ${dueCount} due cards`}</span>
                </button>
              )}
            </div>
          </div>

          {/* Learning metrics (real, user-scoped) */}
          <div className={styles.metrics}>
            <div className={styles.metricsHead}>
              <span className={styles.metricsIcon} aria-hidden="true"><Activity className="h-[17px] w-[17px]" /></span>
              <h2 className={styles.metricsTitle}>{vi ? "Chỉ số học tập" : "Learning Metrics"}</h2>
              <span className={styles.verified}>{vi ? "Thực tế" : "Verified"}</span>
            </div>

            <div className={styles.tiles}>
              <div className={styles.tile} data-testid="hero-due-cards" data-kind="due">
                <p className={styles.tileLabel}>{vi ? "Thẻ cần ôn hôm nay" : "Due Cards Today"}</p>
                <div className={styles.tileFigure}>
                  {dueLoading ? (
                    <span className={`${styles.skeleton} h-9 w-11`} aria-label={vi ? "Đang tải" : "Loading"} />
                  ) : (
                    <span className={styles.tileValue}>{dueCount}</span>
                  )}
                  <span className={styles.tileUnit}>{vi ? "thẻ cần ôn" : "cards due"}</span>
                </div>
                <p className={styles.tileNote}>
                  <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{reviewSessionText}</span>
                </p>
              </div>

              <div className={styles.tile} data-testid="hero-streak" data-kind="streak">
                <p className={styles.tileLabel}>{vi ? "Chuỗi ngày liên tục" : "Current Streak"}</p>
                <div className={styles.streakRow}>
                  <div className={styles.ring} style={{ "--fill": streakFill } as React.CSSProperties} aria-hidden="true">
                    <svg viewBox="0 0 44 44" className={styles.ringArc}><circle cx="22" cy="22" r="18" className={styles.ringTrack} /><circle cx="22" cy="22" r="18" pathLength={100} className={styles.ringFill} /></svg>
                    <StreakFlame lit={currentStreakDays > 0} />
                  </div>
                  <div className={styles.tileFigure}>
                    {streakLoading && !unifiedStreak ? (
                      <span className={`${styles.skeleton} h-9 w-11`} aria-label={vi ? "Đang tải" : "Loading"} />
                    ) : (
                      <span className={`${styles.tileValue} ${styles.tileValueWarm}`}>{currentStreakDays}</span>
                    )}
                    <span className={styles.tileUnit}>{vi ? "ngày streak" : "day streak"}</span>
                  </div>
                </div>
                <p className={`${styles.tileNote} ${styles.tileNoteWarm}`}>
                  {currentStreakDays > 0
                    ? (vi ? `Duy trì chuỗi ${currentStreakDays} ngày` : `Active streak: ${currentStreakDays} days`)
                    : (vi ? "Bắt đầu chuỗi học tập hôm nay" : "Start your streak today")}
                </p>
              </div>
            </div>

            {/* Leaderboard: weekly Thi đua rank + current CEFR (→ /leaderboard) */}
            {userEmail && <LeaderboardWidget />}
          </div>
        </div>
      </section>

      {/* ─── SECTION 2: LEARNING GATEWAYS (6 CORE DOMAINS) ─────────────────────────────────────────── */}
      <section id="expedition-modules" className="scroll-mt-24 space-y-5" data-purpose="learning-modules-grid" aria-labelledby="expedition-modules-title">
        <DashboardSectionHeader
          id="expedition-modules-title"
          eyebrow={vi ? "6 kỹ năng cốt lõi" : "6 core skills"}
          title={vi ? "Khám phá các phân khu học tập" : "Explore your learning areas"}
          lead={vi ? "Lựa chọn mục tiêu rèn luyện phù hợp với thời gian biểu của bạn" : "Pick the practice that fits your schedule today"}
        />

        <div className={styles.gatewayZone}>
          <div className={styles.gateways}>
            {modules.map(({ id, tone, icon: Icon, badge, title, text, metric, cta }) => (
              <div key={id} data-morph-source={`gateway-${id}`} className="min-w-0">
              <article
                style={{ height: '100%' }}
                tabIndex={0}
                role="button"
                data-card={id}
                data-tone={tone}
                aria-label={`${title}. ${metric}. ${cta}`}
                onClick={() => onNavigate(id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onNavigate(id);
                  }
                }}
                className={styles.card}
                {...pointerLight}
              >
                <span className={styles.cardRim} aria-hidden="true" />
                <span className={styles.cardSpecular} aria-hidden="true" />
                <div className={styles.cardStage} aria-hidden="true">
                  <span className={styles.cardIcon}><Icon className="h-[18px] w-[18px]" /></span>
                  <GatewayEmblem kind={id} className={styles.emblem} />
                </div>
                <h3 className={styles.cardTitle}>{title}</h3>
                <p className={styles.cardText}>{text}</p>
                <p className={styles.cardMetric}><span className="line-clamp-2">{metric}</span></p>
                <div className={styles.cardFoot}>
                  <span className={styles.cardBadge}>{badge}</span>
                  <span className={styles.cardCta}>
                    <span className="sr-only">{cta}</span>
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </div>
              </article>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── SECTION 3: WEEKLY PODIUM (default Tuần = leaderboard default) + TODAY'S REAL CONTENT ────── */}
      <ContentDiscoveryHub onNavigate={onNavigate} leading={userEmail ? <TopLearnersWidget /> : null} />
    </div>
  );
}
