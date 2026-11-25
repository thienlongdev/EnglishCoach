package com.englishcoach.premium.service;

import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.dto.PremiumMeResponseDto;
import com.englishcoach.premium.entity.PremiumAiUsage;
import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.exception.PremiumLimitReachedException;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Free daily allowances (3 shared AI uses, 10 Coach messages, 1 book import) and Premium fair use, on a mocked ledger. */
@ExtendWith(MockitoExtension.class)
class PremiumUsageAndEntitlementTest {

    @Mock
    private PremiumFeatureDefinitionRepository featureRepository;

    @Mock
    private PremiumAiUsageRepository usageRepository;

    @Mock
    private PremiumSubscriptionService subscriptionService;

    @Mock
    private PremiumPlanRepository planRepository;

    /** Real defaults: Asia/Ho_Chi_Minh, 3 AI uses, 10 Coach messages, 1 book import a day. */
    @Spy
    private PremiumProperties properties = new PremiumProperties();

    @InjectMocks
    private PremiumUsageService usageService;

    private PremiumEntitlementService entitlementService;

    private PremiumFeatureDefinition roleplayFeature;
    private PremiumFeatureDefinition pronunciationFeature;
    private PremiumFeatureDefinition freeTtsFeature;

    @BeforeEach
    void setUp() {
        entitlementService = new PremiumEntitlementService(subscriptionService, usageService, planRepository, featureRepository);
        roleplayFeature = feature(1L, "SPEAKING_ROLEPLAY", true, 100);
        pronunciationFeature = feature(2L, "SPEAKING_PRONUNCIATION", true, 200);
        freeTtsFeature = feature(3L, "SPEAKING_TTS", false, 0);
    }

    private static PremiumFeatureDefinition feature(long id, String key, boolean premium, int monthly) {
        return PremiumFeatureDefinition.builder().id(id).featureKey(key).displayName(key).premiumRequired(premium)
                .freeTrialLimit(premium ? 5 : 0).premiumMonthlyLimit(monthly).enabled(true).build();
    }

    private void usedToday(Object[]... rows) {
        when(usageRepository.countTrialPerFeatureSince(anyLong(), any(Collection.class), any(Instant.class))).thenReturn(List.of(rows));
    }

    private void saves(long id) {
        when(usageRepository.save(any(PremiumAiUsage.class))).thenAnswer(inv -> {
            PremiumAiUsage u = inv.getArgument(0);
            u.setId(id);
            return u;
        });
    }

    @Test
    @DisplayName("Free user with nothing used today reserves one of the shared daily AI uses")
    void testFreeUserInitialTrial() {
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "SPEAKING_ROLEPLAY", "req-1")).thenReturn(Optional.empty());
        usedToday();
        saves(101L);

        assertThat(usageService.reserveUsage(200L, "SPEAKING_ROLEPLAY", "req-1", false)).isEqualTo(101L);
        verify(usageRepository).save(argThat(u -> "TRIAL".equals(u.getUsageKind()) && "RESERVED".equals(u.getStatus())));
    }

    @Test
    @DisplayName("The 4th AI use of the day is refused before any work, whichever AI features the first three used")
    void testFreeUserDailyAiPoolIsSharedAcrossFeatures() {
        when(featureRepository.findByFeatureKey("SPEAKING_PRONUNCIATION")).thenReturn(Optional.of(pronunciationFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "SPEAKING_PRONUNCIATION", "req-4")).thenReturn(Optional.empty());
        // 2 role-play + 1 writing feedback today; Coach messages and book imports are other allowances
        usedToday(new Object[]{"SPEAKING_ROLEPLAY", 2L}, new Object[]{"WRITING_AI_FEEDBACK", 1L},
                new Object[]{"COACH_CHAT", 9L}, new Object[]{"MY_BOOKS_IMPORT", 1L});

        assertThatThrownBy(() -> usageService.reserveUsage(200L, "SPEAKING_PRONUNCIATION", "req-4", false))
                .isInstanceOf(PremiumRequiredException.class)
                .satisfies(ex -> {
                    PremiumRequiredException p = (PremiumRequiredException) ex;
                    assertThat(p.getFeatureKey()).isEqualTo("SPEAKING_PRONUNCIATION");
                    assertThat(p.getMessage()).contains("3 lượt AI miễn phí hôm nay");
                    assertThat(p.getResetsAt()).isEqualTo(LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh")).plusDays(1)
                            .atStartOfDay(ZoneId.of("Asia/Ho_Chi_Minh")).toInstant());
                });
        verify(usageRepository, never()).save(any());
    }

    @Test
    @DisplayName("Only rows of the current local day count: the boundary is local midnight (Asia/Ho_Chi_Minh)")
    void testDailyBoundaryIsLocalMidnight() {
        ZoneId vn = ZoneId.of("Asia/Ho_Chi_Minh");
        assertThat(usageService.dayStart()).isEqualTo(LocalDate.now(vn).atStartOfDay(vn).toInstant());
        assertThat(usageService.nextReset()).isEqualTo(usageService.dayStart().plusSeconds(86_400));
        usedToday();
        Instant start = usageService.dayStart();
        usageService.dailyAllowances(200L);
        verify(usageRepository).countTrialPerFeatureSince(eq(200L), any(Collection.class), eq(start));
    }

    @Test
    @DisplayName("Echo Coach: 10 messages a day, separate from the 3 AI uses; Premium is not metered here")
    void testCoachAllowanceIsSeparate() {
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(eq(200L), eq("COACH_CHAT"), anyString())).thenReturn(Optional.empty());
        usedToday(new Object[]{"SPEAKING_ROLEPLAY", 3L}, new Object[]{"COACH_CHAT", 9L});
        saves(301L);
        assertThat(usageService.reserveUsage(200L, "COACH_CHAT", null, false)).isEqualTo(301L); // 10th message: allowed

        usedToday(new Object[]{"COACH_CHAT", 10L});
        assertThatThrownBy(() -> usageService.reserveUsage(200L, "COACH_CHAT", null, false))
                .isInstanceOf(PremiumRequiredException.class).hasMessageContaining("10 tin nhắn Echo Coach");

        assertThat(usageService.reserveUsage(300L, "COACH_CHAT", null, true)).isNull();
    }

    @Test
    @DisplayName("A released request id used again is re-reserved in place (never a duplicate row)")
    void testReleasedRequestIsReReserved() {
        PremiumAiUsage released = PremiumAiUsage.builder().id(55L).userId(200L).featureKey("SPEAKING_ROLEPLAY")
                .requestId("turn-1").usageKind("TRIAL").status("RELEASED").build();
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "SPEAKING_ROLEPLAY", "turn-1")).thenReturn(Optional.of(released));
        usedToday(new Object[]{"SPEAKING_ROLEPLAY", 1L});
        when(usageRepository.reactivate(eq(55L), eq("TRIAL"), anyString())).thenReturn(1);

        assertThat(usageService.reserveUsage(200L, "SPEAKING_ROLEPLAY", "turn-1", false)).isEqualTo(55L);
        verify(usageRepository, never()).save(any());
    }

    @Test
    @DisplayName("Same request id already charged = idempotent replay (no second unit)")
    void testIdempotentReplay() {
        PremiumAiUsage done = PremiumAiUsage.builder().id(56L).userId(200L).featureKey("SPEAKING_ROLEPLAY")
                .requestId("turn-2").usageKind("TRIAL").status("COMPLETED").build();
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "SPEAKING_ROLEPLAY", "turn-2")).thenReturn(Optional.of(done));
        assertThat(usageService.reserveUsage(200L, "SPEAKING_ROLEPLAY", "turn-2", false)).isEqualTo(56L);
        verify(usageRepository, never()).countTrialPerFeatureSince(anyLong(), any(), any());
        verify(usageRepository, never()).save(any());
    }

    @Test
    @DisplayName("My Books: one new book a day for a free account; the same book again is not an extra book")
    void testBookGrants() {
        String a = "a".repeat(64), b = "b".repeat(64);
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "MY_BOOKS_IMPORT", "fp:" + a)).thenReturn(Optional.empty());
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "MY_BOOKS_IMPORT", "fp:" + b)).thenReturn(Optional.empty());
        usedToday();
        saves(401L);
        PremiumUsageService.BookGrant g = usageService.grantBookImports(200L, List.of(a, b), false);
        assertThat(g.granted()).containsExactly(a);
        assertThat(g.refused()).containsExactly(b);
        assertThat(g.allowance().remaining()).isZero();

        // already granted (also after the book was deleted on the device): granted again, no new unit
        PremiumAiUsage known = PremiumAiUsage.builder().id(401L).userId(200L).featureKey("MY_BOOKS_IMPORT").requestId("fp:" + a)
                .usageKind("TRIAL").status("COMPLETED").build();
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(200L, "MY_BOOKS_IMPORT", "fp:" + a)).thenReturn(Optional.of(known));
        usedToday(new Object[]{"MY_BOOKS_IMPORT", 1L});
        PremiumUsageService.BookGrant again = usageService.grantBookImports(200L, List.of(a), false);
        assertThat(again.granted()).containsExactly(a);
        verify(usageRepository, times(1)).save(any());

        // Premium: no daily cap
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(300L, "MY_BOOKS_IMPORT", "fp:" + b)).thenReturn(Optional.empty());
        assertThat(usageService.grantBookImports(300L, List.of(b), true).granted()).containsExactly(b);
        assertThatThrownBy(() -> usageService.grantBookImports(200L, List.of("../etc"), false)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("Failed request release marks reservation as RELEASED idempotently")
    void testFailedRequestRelease() {
        PremiumAiUsage reserved = PremiumAiUsage.builder().id(10L).userId(200L).featureKey("SPEAKING_ROLEPLAY")
                .requestId("req-fail").usageKind("TRIAL").status("RESERVED").build();
        when(usageRepository.findById(10L)).thenReturn(Optional.of(reserved));

        usageService.releaseReservation(10L);
        assertThat(reserved.getStatus()).isEqualTo("RELEASED");
        verify(usageRepository).save(reserved);

        usageService.releaseReservation(10L);
        verify(usageRepository, times(1)).save(reserved);
    }

    @Test
    @DisplayName("Premium active user bypasses the free daily allowance and uses monthly fair-use")
    void testPremiumUserFairUse() {
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(300L, "SPEAKING_ROLEPLAY", "req-prem-1")).thenReturn(Optional.empty());
        when(usageRepository.countByUserIdAndFeatureKeyAndUsageKindAndBillingCycleMonthAndStatusIn(
                eq(300L), eq("SPEAKING_ROLEPLAY"), eq("PREMIUM"), anyString(), any(Collection.class))).thenReturn(10);
        saves(201L);

        assertThat(usageService.reserveUsage(300L, "SPEAKING_ROLEPLAY", "req-prem-1", true)).isEqualTo(201L);
        verify(usageRepository, never()).countTrialPerFeatureSince(anyLong(), any(), any());
    }

    @Test
    @DisplayName("Premium user reaching monthly limit gets PremiumLimitReachedException")
    void testPremiumUserExceedsMonthlyLimit() {
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(300L, "SPEAKING_ROLEPLAY", "req-prem-101")).thenReturn(Optional.empty());
        when(usageRepository.countByUserIdAndFeatureKeyAndUsageKindAndBillingCycleMonthAndStatusIn(
                eq(300L), eq("SPEAKING_ROLEPLAY"), eq("PREMIUM"), anyString(), any(Collection.class))).thenReturn(100);

        assertThatThrownBy(() -> usageService.reserveUsage(300L, "SPEAKING_ROLEPLAY", "req-prem-101", true))
                .isInstanceOf(PremiumLimitReachedException.class);
    }

    @Test
    @DisplayName("Non-premium feature (SPEAKING_TTS) is never blocked and does not consume quota")
    void testNonPremiumFeatureAlwaysAllowed() {
        when(featureRepository.findByFeatureKey("SPEAKING_TTS")).thenReturn(Optional.of(freeTtsFeature));
        assertThat(usageService.reserveUsage(200L, "SPEAKING_TTS", "req-tts-1", false)).isNull();
        verify(usageRepository, never()).save(any());
    }

    @Test
    @DisplayName("getPremiumMe counts a Premium user's monthly uses of every feature in one statement")
    void testGetPremiumMePremiumUserMonthlyCounts() {
        Long userId = 201L;
        PremiumPlan plan = PremiumPlan.builder().code("PREMIUM_1M").name("1 tháng").durationMonths(1).build();
        PremiumSubscription sub = PremiumSubscription.builder().plan(plan)
                .startsAt(Instant.now().minusSeconds(3600)).expiresAt(Instant.now().plusSeconds(86400 * 10)).build();
        when(subscriptionService.getActiveSubscription(userId)).thenReturn(Optional.of(sub));
        when(featureRepository.findByEnabledTrueOrderBySortOrderAsc()).thenReturn(List.of(roleplayFeature, pronunciationFeature, freeTtsFeature));
        when(usageRepository.countPerFeatureInMonth(eq(userId), eq("PREMIUM"), anyString(), any(Collection.class)))
                .thenReturn(List.<Object[]>of(new Object[]{"SPEAKING_ROLEPLAY", 100L}, new Object[]{"SPEAKING_PRONUNCIATION", 7L}));

        PremiumMeResponseDto me = entitlementService.getPremiumMe(userId);

        assertThat(me.isPremium()).isTrue();
        var rp = me.getFeatureEntitlements().stream().filter(f -> f.getFeatureKey().equals("SPEAKING_ROLEPLAY")).findFirst().get();
        assertThat(rp.getPremiumMonthlyRemaining()).isZero();
        assertThat(rp.isPremiumAllowed()).isFalse();
        var pron = me.getFeatureEntitlements().stream().filter(f -> f.getFeatureKey().equals("SPEAKING_PRONUNCIATION")).findFirst().get();
        assertThat(pron.getPremiumMonthlyRemaining()).isEqualTo(193);
        assertThat(pron.isPremiumAllowed()).isTrue();
        verify(usageRepository, times(1)).countPerFeatureInMonth(any(), any(), any(), any());
    }

    @Test
    @DisplayName("getPremiumMe (free): every AI feature shows the SHARED daily allowance; Coach and books their own")
    void testGetPremiumMeFreeUser() {
        Long userId = 200L;
        when(subscriptionService.getActiveSubscription(userId)).thenReturn(Optional.empty());
        when(featureRepository.findByEnabledTrueOrderBySortOrderAsc()).thenReturn(List.of(roleplayFeature, pronunciationFeature, freeTtsFeature));
        usedToday(new Object[]{"SPEAKING_ROLEPLAY", 2L}, new Object[]{"COACH_CHAT", 4L});

        PremiumMeResponseDto me = entitlementService.getPremiumMe(userId);
        verify(usageRepository, never()).countPerFeatureInMonth(any(), any(), any(), any());
        verify(usageRepository, times(1)).countTrialPerFeatureSince(anyLong(), any(), any());

        assertThat(me.isPremium()).isFalse();
        var rp = me.getFeatureEntitlements().stream().filter(f -> f.getFeatureKey().equals("SPEAKING_ROLEPLAY")).findFirst().get();
        assertThat(rp.getTrialLimit()).isEqualTo(3);
        assertThat(rp.getTrialUsed()).isEqualTo(2);
        assertThat(rp.getTrialRemaining()).isEqualTo(1);
        assertThat(rp.isPremiumAllowed()).isTrue();
        var pron = me.getFeatureEntitlements().stream().filter(f -> f.getFeatureKey().equals("SPEAKING_PRONUNCIATION")).findFirst().get();
        assertThat(pron.getTrialRemaining()).isEqualTo(1); // shared with role-play
        var tts = me.getFeatureEntitlements().stream().filter(f -> f.getFeatureKey().equals("SPEAKING_TTS")).findFirst().get();
        assertThat(tts.isPremiumAllowed()).isTrue();

        assertThat(me.getFreeDaily()).extracting(PremiumMeResponseDto.DailyAllowanceDto::getPool).containsExactly("AI", "COACH", "BOOK");
        var coach = me.getFreeDaily().stream().filter(a -> a.getPool().equals("COACH")).findFirst().get();
        assertThat(coach.getLimit()).isEqualTo(10);
        assertThat(coach.getRemaining()).isEqualTo(6);
        assertThat(me.getFreeDaily().get(2).getLimit()).isEqualTo(1);
    }

    @Test
    @DisplayName("Advisory lock fails closed when JdbcTemplate throws and uses unified pool key + 2-arg pg_advisory_xact_lock")
    void testAdvisoryLockFailsClosedAndUsesUnifiedPoolKey() {
        org.springframework.jdbc.core.JdbcTemplate jdbc = mock(org.springframework.jdbc.core.JdbcTemplate.class);
        org.springframework.test.util.ReflectionTestUtils.setField(usageService, "jdbcTemplate", jdbc);
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(jdbc.query(eq("SELECT pg_advisory_xact_lock(?, hashtext(?))"), any(org.springframework.jdbc.core.ResultSetExtractor.class), eq(92133), eq("300:pool:AI")))
                .thenThrow(new org.springframework.dao.DataAccessResourceFailureException("db down"));

        assertThatThrownBy(() -> usageService.reserveUsage(300L, "SPEAKING_ROLEPLAY", "req-lock-fail", true))
                .isInstanceOf(org.springframework.dao.DataAccessResourceFailureException.class);
        verify(usageRepository, never()).save(any());
    }

    @Test
    @DisplayName("Feature definition lookup is cached across repeated reservations to eliminate redundant DB RTTs")
    void testFeatureDefinitionIsCached() {
        when(featureRepository.findByFeatureKey("SPEAKING_ROLEPLAY")).thenReturn(Optional.of(roleplayFeature));
        when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(eq(200L), eq("SPEAKING_ROLEPLAY"), anyString())).thenReturn(Optional.empty());
        usedToday();
        saves(701L);

        usageService.reserveUsage(200L, "SPEAKING_ROLEPLAY", "req-cache-1", false);
        usageService.reserveUsage(200L, "SPEAKING_ROLEPLAY", "req-cache-2", false);
        assertThat(usageService.premiumMonthlyLimit("SPEAKING_ROLEPLAY")).isEqualTo(100);

        verify(featureRepository, times(1)).findByFeatureKey("SPEAKING_ROLEPLAY");
    }

    @Test
    @DisplayName("Stale sync reservation reaper uses UPDATE with strict allowlist excluding async/book/exam/grammar features")
    @SuppressWarnings("unchecked")
    void testStaleSyncReservationReaperAllowlist() {
        when(usageRepository.releaseStaleSyncReservations(any(Instant.class), any(Collection.class))).thenReturn(2);

        Instant before = Instant.now();
        int released = usageService.releaseStaleSyncReservations();
        assertThat(released).isEqualTo(2);

        org.mockito.ArgumentCaptor<Instant> cutoffCaptor = org.mockito.ArgumentCaptor.forClass(Instant.class);
        org.mockito.ArgumentCaptor<Collection<String>> featuresCaptor = org.mockito.ArgumentCaptor.forClass(Collection.class);
        verify(usageRepository).releaseStaleSyncReservations(cutoffCaptor.capture(), featuresCaptor.capture());

        assertThat(cutoffCaptor.getValue()).isBeforeOrEqualTo(before.minusSeconds(15 * 60L - 2));
        assertThat(featuresCaptor.getValue()).contains("SPEAKING_ROLEPLAY", "WRITING_AI_FEEDBACK", "READING_CONTEXT_EXPLANATION");
        assertThat(featuresCaptor.getValue()).doesNotContain(
                "MY_BOOKS_IMPORT",
                "EXAM_AI_SCORING",
                "LISTENING_YOUTUBE_IMPORT",
                "LISTENING_DOCUMENT_IMPORT",
                "WRITING_ASSESSMENT",
                "GRAMMAR_PROFESSOR",
                "COACH_CHAT"
        );
    }
}
