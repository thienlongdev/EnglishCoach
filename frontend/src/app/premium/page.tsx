'use client';

import React, { useState, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { usePremiumEntitlement } from '@/hooks/usePremiumEntitlement';
import {
  ArrowRight,
  AudioWaveform,
  BookOpen,
  BookOpenText,
  CalendarDays,
  Check,
  ClipboardCheck,
  Crown,
  Gem,
  Globe,
  Headphones,
  Languages,
  MessagesSquare,
  Mic,
  MonitorPlay,
  PenLine,
  Repeat2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import {
  dailyAllowance,
  ECHO_LIMITS,
  FREE_DAILY_LIMITS,
  type DailyPool,
  type PremiumFeatureEntitlementDto,
} from '@/services/premiumApi';
import { paymentApi, PaymentOrderResponse } from '@/services/paymentApi';
import { PaymentCheckoutModal } from '@/components/features/premium/PaymentCheckoutModal';
import { PlanCalendar, PremiumBackdrop, PremiumCrownArt } from '@/components/features/premium/PremiumScene';
import styles from '@/components/features/premium/premiumGlass.module.css';
import { pointerLight } from '@/lib/ui/pointerLight';
import { echoSrc } from '@/lib/brand/echoCharacters';

/**
 * Learner-facing names of the gated AI features (the server catalog decides which exist and their limits; this only
 * words them). Every claim here must stay true of the server: see features/premium-payment.
 */
const FEATURE_COPY: Record<string, { name: string; detail: string }> = {
  SPEAKING_ROLEPLAY: { name: 'Hội thoại với AI', detail: 'Nói chuyện nhiều lượt theo tình huống, AI trả lời và góp ý.' },
  SPEAKING_PRONUNCIATION: { name: 'Phân tích phát âm', detail: 'Chỉ ra âm đọc sai trong từng từ và cách sửa.' },
  SPEAKING_SHADOWING: { name: 'Chấm nói nhại (Shadowing)', detail: 'So sánh câu bạn nói với câu mẫu.' },
  SPEAKING_QUICK_CHECK: { name: 'Kiểm tra phát âm nhanh', detail: 'Nhận xét nhanh một câu ngắn.' },
  WRITING_AI_FEEDBACK: { name: 'Chữa bài viết', detail: 'Nhận xét ngữ pháp, cách dùng từ và gợi ý viết lại.' },
  TRANSLATION_AI_GRADING: { name: 'Chấm bài dịch', detail: 'Đánh giá bản dịch câu và đoạn văn.' },
  READING_CONTEXT_EXPLANATION: { name: 'Giải nghĩa theo ngữ cảnh', detail: 'Giải thích từ, cụm từ trong đúng câu bạn đang đọc.' },
  LISTENING_YOUTUBE_IMPORT: { name: 'Tạo bài nghe từ YouTube', detail: 'Lấy phụ đề và tạo bài luyện nghe từ video.' },
  LISTENING_DOCUMENT_IMPORT: { name: 'Tạo bài nghe từ tài liệu', detail: 'Đọc thành tiếng đoạn văn bạn đã kiểm tra.' },
  EXAM_AI_SCORING: { name: 'Chấm Nói và Viết trong thi thử', detail: 'Ước lượng theo tiêu chí luyện tập, không phải điểm chính thức.' },
  ECHO_ANYWHERE_AI: { name: 'Echo AI trên mọi website', detail: 'Giải thích, tóm tắt và quiz trong tiện ích Echo Anywhere. Chỉ dành cho Premium.' },
};

/** The semantic icon and colour family of each feature (presentation only). */
const FEATURE_LOOK: Record<string, { icon: LucideIcon; tone: string }> = {
  SPEAKING_ROLEPLAY: { icon: MessagesSquare, tone: 'rose' },
  SPEAKING_PRONUNCIATION: { icon: AudioWaveform, tone: 'rose' },
  SPEAKING_SHADOWING: { icon: Repeat2, tone: 'rose' },
  SPEAKING_QUICK_CHECK: { icon: Mic, tone: 'rose' },
  WRITING_AI_FEEDBACK: { icon: PenLine, tone: 'violet' },
  TRANSLATION_AI_GRADING: { icon: Languages, tone: 'violet' },
  READING_CONTEXT_EXPLANATION: { icon: BookOpenText, tone: 'emerald' },
  LISTENING_YOUTUBE_IMPORT: { icon: MonitorPlay, tone: 'amber' },
  LISTENING_DOCUMENT_IMPORT: { icon: Headphones, tone: 'amber' },
  EXAM_AI_SCORING: { icon: ClipboardCheck, tone: 'sky' },
  ECHO_ANYWHERE_AI: { icon: Globe, tone: 'sky' },
};

/** Published monthly Premium limits, shown to visitors before the account's own catalog loads (V36 / V91 values). */
const DEFAULT_FEATURES: Array<Pick<PremiumFeatureEntitlementDto, 'featureKey' | 'premiumMonthlyLimit'>> = [
  { featureKey: 'SPEAKING_ROLEPLAY', premiumMonthlyLimit: 300 },
  { featureKey: 'SPEAKING_PRONUNCIATION', premiumMonthlyLimit: 300 },
  { featureKey: 'SPEAKING_SHADOWING', premiumMonthlyLimit: 300 },
  { featureKey: 'SPEAKING_QUICK_CHECK', premiumMonthlyLimit: 300 },
  { featureKey: 'WRITING_AI_FEEDBACK', premiumMonthlyLimit: 200 },
  { featureKey: 'TRANSLATION_AI_GRADING', premiumMonthlyLimit: 250 },
  { featureKey: 'READING_CONTEXT_EXPLANATION', premiumMonthlyLimit: 300 },
  { featureKey: 'LISTENING_YOUTUBE_IMPORT', premiumMonthlyLimit: 50 },
  { featureKey: 'LISTENING_DOCUMENT_IMPORT', premiumMonthlyLimit: 30 },
  { featureKey: 'EXAM_AI_SCORING', premiumMonthlyLimit: 30 },
];

const FREE_ALWAYS = [
  'Từ điển, thẻ từ vựng và Lộ trình học',
  'Thư viện Đọc, Nghe và chép chính tả',
  'Nói theo chủ đề, luyện viết tự do',
  'Thi thử trắc nghiệm và trò chơi học từ',
];

const PLAN_BENEFITS = [
  'Hạn mức AI hằng tháng cho từng tính năng',
  `Echo ${ECHO_LIMITS.premium.perDay} tin nhắn mỗi ngày, tối đa ${ECHO_LIMITS.premium.perMonth} mỗi tháng`,
  'Nhập sách không giới hạn số cuốn mỗi ngày',
  'Giữ nguyên mọi tính năng miễn phí',
];

const POOL_LABEL: Record<DailyPool, string> = { AI: 'lượt AI', COACH: 'tin nhắn Echo Coach', BOOK: 'lượt nhập sách' };

const WhaleMark = () => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={echoSrc('official', 24)} alt="" width={18} height={18} className={styles.whaleMark} />
);

export default function PremiumPricingPage() {
  const { data: session } = useSession();
  const { entitlement, plans, plansError, isPremium, mutateEntitlement } = usePremiumEntitlement();
  const [selectedPlanCode, setSelectedPlanCode] = useState<string>('PLAN_3_MONTHS');
  const [currentOrder, setCurrentOrder] = useState<PaymentOrderResponse | null>(null);
  const [isCreatingOrder, setIsCreatingOrder] = useState<boolean>(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const displayPlans = plans ?? [];

  const serverFeatures = entitlement?.featureEntitlements?.filter((f) => f.premiumRequired) ?? [];
  const displayFeatures = serverFeatures.length > 0 ? serverFeatures : DEFAULT_FEATURES;
  const signedInFree = Boolean(session?.user) && Boolean(entitlement) && !isPremium;
  const today = (['AI', 'COACH', 'BOOK'] as DailyPool[]).map((pool) => ({ pool, a: dailyAllowance(entitlement, pool) }));
  const todayKnown = today.filter((t) => t.a);

  const formatVnd = (amount: number) => new Intl.NumberFormat('vi-VN').format(amount) + 'đ';
  const getMonthlyRate = (priceVnd: number, months: number) => Math.round(priceVnd / months);
  const monthlyPrice = displayPlans.find((plan) => plan.durationMonths === 1)?.priceVnd;
  const getSavingsLabel = (price: number, months: number) => {
    if (!monthlyPrice || months <= 1) return null;
    const percent = 100 * (1 - price / (monthlyPrice * months));
    if (percent <= 0) return null;
    const rounded = Math.round(percent);
    return percent < rounded ? `Tiết kiệm gần ${rounded}%` : `Tiết kiệm ~${rounded}%`;
  };

  const handleCtaClick = async (planCode: string) => {
    setSelectedPlanCode(planCode);
    setCheckoutError(null);

    if (!session?.user) {
      window.location.href = `/login?callbackUrl=${encodeURIComponent('/premium')}`;
      return;
    }

    setIsCreatingOrder(true);
    try {
      const order = await paymentApi.createPaymentOrder(planCode);
      setCurrentOrder(order);
    } catch (err: any) {
      console.error('Failed to create payment order:', err);
      const msg = err.response?.data?.message || 'Không thể khởi tạo đơn thanh toán. Vui lòng thử lại sau.';
      setCheckoutError(msg);
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const handleRenewOrder = async (planCode: string) => {
    try {
      const order = await paymentApi.createPaymentOrder(planCode);
      setCurrentOrder(order);
    } catch (err: any) {
      console.error('Failed to renew payment order:', err);
      const msg = err.response?.data?.message || 'Không thể tạo đơn mới. Vui lòng thử lại.';
      alert(msg);
    }
  };

  const handlePaymentSuccess = useCallback(async () => {
    try {
      await mutateEntitlement();
    } catch (err) {
      console.error('Failed to refresh entitlement:', err);
    }
  }, [mutateEntitlement]);

  return (
    <div className={styles.page}>
      <PremiumBackdrop />

      <div className={styles.inner}>
        {/* Hero — the page's identity and the real value Premium adds */}
        <section className={styles.hero} aria-labelledby="premium-title" {...pointerLight}>
          <div className={styles.heroCopy}>
            <h1 id="premium-title" className={styles.title}>
              <span className={styles.titleEyebrow}><Crown aria-hidden="true" />English Coach</span>{' '}
              <span className={styles.titleWord}>Premium</span>
            </h1>
            <p className={styles.lead}>
              Học miễn phí mỗi ngày. Nâng cấp khi bạn cần nhiều phản hồi AI hơn cho Nói, Viết, Đọc và thi thử.
            </p>
            <ul className={styles.facts}>
              <li><span className={styles.factIcon} aria-hidden="true"><CalendarDays /></span><span>{PLAN_BENEFITS[0]}</span></li>
              <li><span className={styles.factIcon} aria-hidden="true"><WhaleMark /></span><span>{PLAN_BENEFITS[1]}</span></li>
              <li><span className={styles.factIcon} aria-hidden="true"><BookOpen /></span><span>{PLAN_BENEFITS[2]}</span></li>
            </ul>
          </div>
          <PremiumCrownArt />
        </section>

        {/* Active Premium Banner if already subscribed */}
        {isPremium && entitlement?.plan && (
          <section className={styles.status} data-state="active" aria-label="Gói của bạn" data-guide="pm-status">
            <span className={styles.statusMedal} aria-hidden="true"><Crown /></span>
            <div className={styles.statusBody}>
              <p className={styles.statusEyebrow}>
                <span>Gói đang hoạt động</span>
                <span className={styles.statusChip}>{entitlement.plan.name}</span>
              </p>
              <p className={styles.statusMain}>
                {entitlement.daysRemaining > 0
                  ? `Còn lại ${entitlement.daysRemaining} ngày sử dụng`
                  : 'Gói hết hạn hôm nay'}
              </p>
            </div>
            {entitlement.expiresAt && (
              <p className={styles.statusAside}>
                Hết hạn:{' '}
                <strong>
                  {new Date(entitlement.expiresAt).toLocaleDateString('vi-VN', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}
                </strong>
              </p>
            )}
          </section>
        )}

        {/* Signed-in free account: today's own allowances */}
        {signedInFree && (
          <section className={styles.status} data-state="free" aria-label="Gói của bạn" data-premium-today data-guide="pm-status">
            <span className={styles.statusMedal} aria-hidden="true"><UserRound /></span>
            <div className={styles.statusBody}>
              <p className={styles.statusEyebrow}>
                <span>Gói hiện tại</span>
                <span className={styles.statusChip}>Miễn phí</span>
              </p>
              <p className={styles.statusMain}>
                {todayKnown.length > 0 ? (
                  <>
                    <span className={styles.statusLabel}>Hôm nay của bạn: </span>
                    {todayKnown.map((t, i) => (
                      <span key={t.pool}>{i > 0 ? ' · ' : ''}còn {t.a!.remaining}/{t.a!.limit} {POOL_LABEL[t.pool]}</span>
                    ))}
                  </>
                ) : (
                  'Lượt hằng ngày làm mới lúc 0:00 (giờ Việt Nam).'
                )}
              </p>
            </div>
            {todayKnown.length > 0 && <p className={styles.statusAside}>Làm mới lúc 0:00 (giờ Việt Nam)</p>}
          </section>
        )}

        {/* Free vs Premium */}
        <div className={styles.compare} data-premium-compare>
          <section className={styles.tier} data-tier="free" aria-labelledby="tier-free">
            <header className={styles.tierHead}>
              <span className={styles.tierIcon} aria-hidden="true"><UserRound /></span>
              <div>
                <h2 id="tier-free" className={styles.tierTitle}>Miễn phí</h2>
                <p className={styles.tierNote}>Lượt hằng ngày làm mới lúc 0:00 (giờ Việt Nam).</p>
              </div>
            </header>
            <ul className={styles.checks}>
              <li><Check aria-hidden="true" /><span><strong>{FREE_DAILY_LIMITS.AI} lượt AI mỗi ngày</strong>, dùng chung cho mọi tính năng AI bên dưới</span></li>
              <li><Check aria-hidden="true" /><span><strong>{FREE_DAILY_LIMITS.COACH} tin nhắn Echo Coach mỗi ngày</strong>, tính riêng, không trừ vào lượt AI. Mỗi câu trả lời của Echo, gõ hay nói, tính 1 tin nhắn; trong đó có {ECHO_LIMITS.free.deepPerDay} lượt phân tích chuyên sâu mỗi ngày</span></li>
              <li><Check aria-hidden="true" /><span><strong>{FREE_DAILY_LIMITS.BOOK} lượt nhập sách mỗi ngày</strong> vào Sách của tôi</span></li>
              {FREE_ALWAYS.map((item) => (
                <li key={item}><Check aria-hidden="true" /><span>{item}</span></li>
              ))}
            </ul>
          </section>

          <section className={styles.tier} data-tier="premium" aria-labelledby="tier-premium">
            <svg className={styles.tierCrown} viewBox="0 0 240 190" aria-hidden="true">
              <path d="M30 140L16 56L56 100L74 38L102 88L120 14L138 88L166 38L184 100L224 56L210 140Z" />
              <rect x="26" y="134" width="188" height="34" rx="8" />
            </svg>
            <header className={styles.tierHead}>
              <span className={styles.tierIcon} aria-hidden="true"><Crown /></span>
              <div>
                <h2 id="tier-premium" className={styles.tierTitle}>Premium</h2>
                <p className={styles.tierNote}>Hạn mức tính theo tháng, riêng cho từng tính năng.</p>
              </div>
            </header>
            <ul className={styles.checks}>
              <li><Check aria-hidden="true" /><span>Thay {FREE_DAILY_LIMITS.AI} lượt chung mỗi ngày bằng <strong>hạn mức tháng cho từng tính năng</strong> (bảng bên dưới)</span></li>
              <li><Check aria-hidden="true" /><span>Echo Coach <strong>{ECHO_LIMITS.premium.perDay} tin nhắn mỗi ngày, tối đa {ECHO_LIMITS.premium.perMonth} tin nhắn mỗi tháng</strong>; trong đó {ECHO_LIMITS.premium.deepPerDay} lượt phân tích chuyên sâu mỗi ngày (tối đa {ECHO_LIMITS.premium.deepPerMonth} mỗi tháng)</span></li>
              <li><Check aria-hidden="true" /><span>Nhập sách vào Sách của tôi không giới hạn số cuốn mỗi ngày</span></li>
            </ul>
          </section>
        </div>

        {/* Pricing Cards Grid */}
        <section className={styles.plansZone} aria-labelledby="premium-plans-title" data-guide="pm-plans">
          <h2 id="premium-plans-title" className={styles.sectionTitle}>Chọn thời hạn</h2>
          {!displayPlans.length && <p role="status">{plansError ? "Chưa tải được bảng giá. Vui lòng thử lại." : "Đang tải bảng giá…"}</p>}
          <div className={styles.plans}>
            {displayPlans.map((plan) => {
              const isPopular = plan.badge === 'PHỔ BIẾN NHẤT';
              const isBestValue = plan.badge === 'TIẾT KIỆM NHẤT';
              const savings = getSavingsLabel(plan.priceVnd, plan.durationMonths);
              const monthlyRate = getMonthlyRate(plan.priceVnd, plan.durationMonths);
              const tone = isPopular ? 'royal' : isBestValue ? 'emerald' : 'sapphire';
              const PlanIcon = isPopular ? Crown : isBestValue ? Gem : CalendarDays;

              return (
                <article key={plan.id} className={styles.plan} data-tone={tone} data-featured={isPopular ? 'true' : undefined} {...pointerLight}>
                  <span className={styles.planSheen} aria-hidden="true" />
                  {plan.badge && (
                    <span className={styles.planBadge}>
                      {isPopular ? <Crown aria-hidden="true" /> : <Gem aria-hidden="true" />}
                      <span>{plan.badge}</span>
                    </span>
                  )}

                  <div className={styles.planHead}>
                    <span className={styles.planIcon} aria-hidden="true"><PlanIcon /></span>
                    <div className={styles.planName}>
                      <h3>{plan.name}</h3>
                      <p>Thời hạn {plan.durationMonths} tháng</p>
                    </div>
                    <PlanCalendar months={plan.durationMonths} />
                  </div>

                  <div className={styles.priceBlock}>
                    <p className={styles.price}>{formatVnd(plan.priceVnd)}</p>
                    <div className={styles.priceMeta}>
                      <span>~{formatVnd(monthlyRate)} / tháng</span>
                      {savings && <span className={styles.saving}>{savings}</span>}
                    </div>
                  </div>

                  <ul className={styles.planBenefits}>
                    {PLAN_BENEFITS.map((item) => (
                      <li key={item}><Check aria-hidden="true" /><span>{item}</span></li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    disabled={isCreatingOrder}
                    onClick={() => handleCtaClick(plan.code)}
                    className={styles.planCta}
                  >
                    {isCreatingOrder && selectedPlanCode === plan.code ? (
                      <>
                        <span className={styles.spinner} aria-hidden="true" />
                        <span>Đang tạo đơn...</span>
                      </>
                    ) : (
                      <>
                        <span>{isPremium ? 'Gia hạn gói này' : 'Nâng cấp Premium'}</span>
                        <ArrowRight className={styles.ctaArrow} aria-hidden="true" />
                      </>
                    )}
                  </button>
                </article>
              );
            })}
          </div>

          {/* Checkout Error Toast */}
          {checkoutError && (
            <div className={styles.error} role="alert">
              <span>{checkoutError}</span>
              <button
                type="button"
                onClick={() => setCheckoutError(null)}
                className={styles.errorClose}
                aria-label="Đóng thông báo"
              >
                ✕
              </button>
            </div>
          )}
        </section>

        {currentOrder && (
          <PaymentCheckoutModal
            order={currentOrder}
            onClose={() => setCurrentOrder(null)}
            onSuccess={handlePaymentSuccess}
            onRenewOrder={handleRenewOrder}
          />
        )}

        {/* AI features and their limits */}
        <section className={styles.features} aria-labelledby="premium-features-title">
          <header className={styles.featuresHead}>
            <span className={styles.featuresIcon} aria-hidden="true"><WhaleMark /></span>
            <div>
              <h2 id="premium-features-title" className={styles.sectionTitle}>Tính năng AI và hạn mức</h2>
              <p className={styles.sectionLead}>
                Miễn phí: {FREE_DAILY_LIMITS.AI} lượt mỗi ngày, dùng chung cho tất cả. Premium: số lượt mỗi tháng của từng tính năng.
              </p>
            </div>
          </header>

          <ul className={styles.featureList}>
            {/* Echo: its own message allowance (owner policy 2026-11-20), separate from the shared AI uses, capped per day and month */}
            {(() => {
              const echo = entitlement?.featureEntitlements?.find((f) => f.featureKey === 'COACH_CHAT');
              const monthLimit = echo?.premiumMonthlyLimit ?? ECHO_LIMITS.premium.perMonth;
              const showRemaining = isPremium && typeof echo?.premiumMonthlyRemaining === 'number';
              const share = showRemaining && monthLimit > 0 ? Math.max(0, Math.min(1, echo!.premiumMonthlyRemaining / monthLimit)) : null;
              return (
                <li key="COACH_CHAT" className={styles.feature} data-echo-limits>
                  <span className={styles.featureIcon} data-tone="sky" aria-hidden="true"><WhaleMark /></span>
                  <div className={styles.featureText}>
                    <p className={styles.featureName}>Trợ lý Echo (nhắn tin và giọng nói)</p>
                    <p className={styles.featureDetail}>
                      Mỗi câu trả lời của Echo, gõ hay nói, tính 1 tin nhắn. Miễn phí {ECHO_LIMITS.free.perDay} tin nhắn mỗi ngày
                      ({ECHO_LIMITS.free.deepPerDay} lượt phân tích chuyên sâu). Premium {ECHO_LIMITS.premium.perDay} tin nhắn mỗi ngày
                      ({ECHO_LIMITS.premium.deepPerDay} lượt phân tích chuyên sâu, tối đa {ECHO_LIMITS.premium.deepPerMonth} mỗi tháng).
                    </p>
                  </div>
                  <div className={styles.featureQuota}>
                    <span>{showRemaining ? `Còn ${echo!.premiumMonthlyRemaining}/${monthLimit} tháng này` : `${monthLimit} tin nhắn/tháng`}</span>
                    {share !== null && <span className={styles.meter} aria-hidden="true"><i style={{ '--q': share } as React.CSSProperties} /></span>}
                  </div>
                </li>
              );
            })()}
            {displayFeatures.map((feat) => {
              const copy = FEATURE_COPY[feat.featureKey];
              const look = FEATURE_LOOK[feat.featureKey];
              const Icon = look?.icon ?? Check;
              const full = feat as Partial<PremiumFeatureEntitlementDto>;
              const showRemaining = isPremium && typeof full.premiumMonthlyRemaining === 'number';
              const share = showRemaining && feat.premiumMonthlyLimit > 0
                ? Math.max(0, Math.min(1, full.premiumMonthlyRemaining! / feat.premiumMonthlyLimit))
                : null;
              return (
                <li key={feat.featureKey} className={styles.feature}>
                  <span className={styles.featureIcon} data-tone={look?.tone ?? 'sky'} aria-hidden="true"><Icon /></span>
                  <div className={styles.featureText}>
                    <p className={styles.featureName}>{copy?.name ?? full.displayName ?? feat.featureKey}</p>
                    <p className={styles.featureDetail}>{copy?.detail ?? full.description ?? ''}</p>
                  </div>
                  <div className={styles.featureQuota}>
                    <span>
                      {showRemaining
                        ? `Còn ${full.premiumMonthlyRemaining}/${feat.premiumMonthlyLimit} tháng này`
                        : `${feat.premiumMonthlyLimit} lượt/tháng`}
                    </span>
                    {share !== null && (
                      <span className={styles.meter} aria-hidden="true"><i style={{ '--q': share } as React.CSSProperties} /></span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Shared document limits */}
        <section className={styles.limits} data-premium-shared-limits>
          <span className={styles.limitsIcon} aria-hidden="true"><BookOpenText /></span>
          <div>
            <h2 className={styles.limitsTitle}>Giới hạn xử lý tài liệu — như nhau cho mọi tài khoản</h2>
            <p className={styles.limitsText}>
              Thư viện Đọc nhận PDF tối đa 30 trang và 6 MB (bản scan tối đa 15 trang cần nhận dạng), ảnh PNG/JPG tối đa 5 MB, tối đa 10.000 từ mỗi tài liệu
              và 20 tài liệu mỗi ngày. Đây là giới hạn để máy chủ xử lý ổn định; Premium không thay đổi các giới hạn này.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
