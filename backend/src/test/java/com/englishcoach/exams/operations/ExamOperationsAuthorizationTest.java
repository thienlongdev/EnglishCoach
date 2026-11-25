package com.englishcoach.exams.operations;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.analytics.ExamLearnerAnalyticsService;
import com.englishcoach.exams.controller.ExamAnalyticsController;
import com.englishcoach.exams.controller.ExamOperationsController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Exams Phase 8D — operations center authorization + no-bypass surface (matrix 37, 38, 48, 50) and the learner analytics
 * isolation surface (16). Standalone MockMvc with a stub principal; the URL rule itself is asserted on the security
 * source (the same approach as PremiumAdminSecurityTest).
 */
class ExamOperationsAuthorizationTest {

    static final UserDetailsImpl LEARNER = new UserDetailsImpl(676L, "learner@example.test", "p", Collections.emptyList());
    static final UserDetailsImpl ADMIN = new UserDetailsImpl(1L, "admin@example.test", "p", Collections.emptyList());

    ExamOperationsService service;
    AdminIdentityService identity;
    MockMvc mvc;
    UserDetailsImpl current;

    @BeforeEach
    void setUp() {
        service = mock(ExamOperationsService.class);
        identity = mock(AdminIdentityService.class);
        when(identity.isOfficialAdmin(1L)).thenReturn(true);
        when(identity.isOfficialAdmin(676L)).thenReturn(false);
        when(service.overview()).thenReturn(new OperationsOverviewDto(Instant.EPOCH, false, "x", Map.of(), Map.of(), Map.of(),
                new LedgerSummaryDto(false, 0, 0, 0, 0), List.of(), Map.of()));
        HandlerMethodArgumentResolver principal = new HandlerMethodArgumentResolver() {
            public boolean supportsParameter(MethodParameter p) {
                return p.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            public Object resolveArgument(MethodParameter p, ModelAndViewContainer m, NativeWebRequest r, WebDataBinderFactory f) {
                return current;
            }
        };
        mvc = MockMvcBuilders.standaloneSetup(new ExamOperationsController(service, identity))
                .setControllerAdvice(new ExamExceptionHandler()).setCustomArgumentResolvers(principal).build();
    }

    @Test
    @DisplayName("37: a learner gets 403 on every operations endpoint (overview, detail, media, QA decision, form) — service never called")
    void learnerDenied() throws Exception {
        current = LEARNER;
        mvc.perform(get("/api/v1/admin/exams/operations/overview")).andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/admin/exams/operations/packages/detail").param("testId", "toeic/ets-2026/test-1"))
                .andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/admin/exams/operations/packages/media").param("testId", "t").param("sha256", "a".repeat(64)))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/admin/exams/operations/qa/decisions").contentType(MediaType.APPLICATION_JSON)
                .content("{\"testId\":\"t\",\"entryId\":\"e\",\"decision\":\"APPROVE\",\"fingerprint\":\"sha256:x\"}"))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(get("/api/v1/admin/exams/operations/forms/" + UUID.randomUUID())).andExpect(status().isForbidden());
        current = null;
        mvc.perform(get("/api/v1/admin/exams/operations/overview")).andExpect(status().isForbidden());
        verifyNoInteractions(service);
    }

    @Test
    @DisplayName("38/50: the official administrator reaches the service; the decision's reviewer is the principal id, never the body")
    void adminAllowed() throws Exception {
        current = ADMIN;
        mvc.perform(get("/api/v1/admin/exams/operations/overview")).andExpect(status().isOk());
        when(service.recordDecision(eq(1L), any())).thenReturn(new QaDecisionReceipt("t", "e", "APPROVE", "admin-user:1",
                "2026-10-04T00:00:00Z", "sha256:x", "OPEN", null, 1, ExamQaDecisionLedger.EFFECT));
        mvc.perform(post("/api/v1/admin/exams/operations/qa/decisions").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"testId\":\"t\",\"entryId\":\"e\",\"decision\":\"APPROVE\",\"fingerprint\":\"sha256:x\","
                                + "\"reviewer\":\"someone-else\",\"reviewedAt\":\"1999-01-01T00:00:00Z\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.reviewer").value("admin-user:1"));
        verify(service).recordDecision(eq(1L), argThat(r -> r.entryId().equals("e")));
        // a refused decision keeps its HTTP status / code (never a 500)
        when(service.recordDecision(eq(1L), any())).thenThrow(new ExamQaDecisionLedger.Rejected(409, "QA_FINGERPRINT_STALE", "x"));
        mvc.perform(post("/api/v1/admin/exams/operations/qa/decisions").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"testId\":\"t\",\"entryId\":\"e\",\"decision\":\"APPROVE\",\"fingerprint\":\"sha256:y\"}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("QA_FINGERPRINT_STALE"));
    }

    @Test
    @DisplayName("48: no force / skip / bypass / override surface; the only mutation is the fingerprinted QA decision")
    void noBypassSurface() {
        Set<String> forbidden = Set.of("force", "skip", "bypass", "override", "trust", "ignore", "reviewer", "reviewedat", "basis");
        for (RecordComponent c : QaDecisionRequest.class.getRecordComponents()) {
            assertFalse(forbidden.stream().anyMatch(f -> c.getName().toLowerCase(Locale.ROOT).contains(f)), c.getName());
        }
        for (RecordComponent c : ImportPlanDto.class.getRecordComponents()) {
            assertFalse(Set.of("force", "skip", "bypass", "override").stream().anyMatch(f -> c.getName().toLowerCase().contains(f)), c.getName());
        }
        int posts = 0;
        for (Method m : ExamOperationsController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(PostMapping.class)) {
                posts++;
                assertArrayEquals(new String[]{"/qa/decisions"}, m.getAnnotation(PostMapping.class).value());
            }
            assertFalse(m.isAnnotationPresent(PutMapping.class) || m.isAnnotationPresent(DeleteMapping.class)
                    || m.isAnnotationPresent(PatchMapping.class), m.getName());
            String lower = m.getName().toLowerCase(Locale.ROOT);
            for (String verb : List.of("publish", "retire", "import", "force", "skip", "override")) {
                assertFalse(lower.contains(verb), "no " + verb + " action in the operations center: " + m.getName());
            }
        }
        assertEquals(1, posts);
    }

    @Test
    @DisplayName("37: operations live under /api/v1/admin/** which the security chain restricts to ROLE_ADMIN")
    void urlRule() throws Exception {
        assertEquals("/api/v1/admin/exams/operations", ExamOperationsController.class.getAnnotation(RequestMapping.class).value()[0]);
        String sec = Files.readString(Path.of("src/main/java/com/englishcoach/common/security/WebSecurityConfig.java"));
        assertTrue(sec.contains(".requestMatchers(\"/api/v1/admin/**\", \"/api/v1/feedback/admin/**\").hasRole(\"ADMIN\")"));
        assertTrue(sec.contains(".requestMatchers(\"/api/v1/exams/**\").authenticated()"), "learner analytics need authentication");
    }

    @Test
    @DisplayName("16: the learner analytics endpoint takes no user id — the subject is always the authenticated principal")
    void analyticsHasNoUserParameter() throws Exception {
        for (Method m : ExamAnalyticsController.class.getDeclaredMethods()) {
            for (Parameter p : m.getParameters()) {
                assertFalse(p.getName().toLowerCase().contains("user") && !p.isAnnotationPresent(AuthenticationPrincipal.class),
                        "no user-selecting parameter: " + p.getName());
                if (p.isAnnotationPresent(RequestParam.class)) {
                    String n = p.getAnnotation(RequestParam.class).value() + p.getAnnotation(RequestParam.class).name() + p.getName();
                    assertFalse(n.toLowerCase().contains("user"), n);
                }
            }
        }
        ExamLearnerAnalyticsService analytics = mock(ExamLearnerAnalyticsService.class);
        MockMvc learnerMvc = MockMvcBuilders.standaloneSetup(new ExamAnalyticsController(analytics))
                .setControllerAdvice(new ExamExceptionHandler()).setCustomArgumentResolvers(new HandlerMethodArgumentResolver() {
                    public boolean supportsParameter(MethodParameter p) {
                        return p.hasParameterAnnotation(AuthenticationPrincipal.class);
                    }

                    public Object resolveArgument(MethodParameter p, ModelAndViewContainer m, NativeWebRequest r, WebDataBinderFactory f) {
                        return LEARNER;
                    }
                }).build();
        learnerMvc.perform(get("/api/v1/exams/analytics").param("family", "TOEIC").param("userId", "1")).andExpect(status().isOk());
        verify(analytics).getAnalytics(eq(676L), any());
        verify(analytics, never()).getAnalytics(eq(1L), any());
        learnerMvc.perform(get("/api/v1/exams/analytics").param("family", "NOT_A_FAMILY")).andExpect(status().isBadRequest());
    }
}
