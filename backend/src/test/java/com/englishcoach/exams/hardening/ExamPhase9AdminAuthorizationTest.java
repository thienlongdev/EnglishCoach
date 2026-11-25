package com.englishcoach.exams.hardening;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentBootstrapService;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.controller.ExamAdminController;
import com.englishcoach.exams.controller.ExamContentAdminController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.measurement.controller.ExamMeasurementController;
import com.englishcoach.exams.measurement.service.*;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamContentService;
import com.englishcoach.exams.service.ExamPublicationService;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.RequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

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
 * Exams Phase 9A — admin / API authorization matrix (security matrix 01–10). Every Exams admin mutation and read is called
 * as ANONYMOUS (no principal), a normal LEARNER and the OFFICIAL ADMIN through standalone MockMvc; the URL rule itself is
 * asserted on the security source. Learners never reach a service; the official admin does.
 */
class ExamPhase9AdminAuthorizationTest {

    static final UserDetailsImpl LEARNER = new UserDetailsImpl(676L, "learner@example.test", "p", Collections.emptyList());
    static final UserDetailsImpl ADMIN = new UserDetailsImpl(1L, "admin@example.test", "p", Collections.emptyList());
    static final Path SRC = Path.of("src/main/java/com/englishcoach");

    ExamPublicationService publication;
    ExamResultService results;
    ExamContentService content;
    AdminIdentityService identity;
    ExamContentPackageImporter importer;
    ExamContentBootstrapService bootstrap;
    ExamContentValidationService validation;
    ExamPracticeService practice;
    com.englishcoach.exams.content.ExamCorpusPracticeReleaseService corpusRelease;
    ExamMeasurementService measurement;
    UserDetailsImpl current;
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        publication = mock(ExamPublicationService.class);
        results = mock(ExamResultService.class);
        content = mock(ExamContentService.class);
        identity = mock(AdminIdentityService.class);
        when(identity.isOfficialAdmin(1L)).thenReturn(true);
        when(identity.isOfficialAdmin(676L)).thenReturn(false);
        importer = mock(ExamContentPackageImporter.class);
        bootstrap = mock(ExamContentBootstrapService.class);
        validation = mock(ExamContentValidationService.class);
        practice = mock(ExamPracticeService.class);
        corpusRelease = mock(com.englishcoach.exams.content.ExamCorpusPracticeReleaseService.class);
        measurement = mock(ExamMeasurementService.class);
        // real permission service: operator rows come from the (mocked) DB = none; the official admin passes by identity
        NamedParameterJdbcTemplate jdbc = mock(NamedParameterJdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), any(org.springframework.jdbc.core.namedparam.SqlParameterSource.class), eq(Integer.class)))
                .thenReturn(0);
        ExamPermissionService permissions = new ExamPermissionService(jdbc, identity);

        HandlerMethodArgumentResolver principal = new HandlerMethodArgumentResolver() {
            public boolean supportsParameter(MethodParameter p) {
                return p.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            public Object resolveArgument(MethodParameter p, ModelAndViewContainer m, NativeWebRequest r, WebDataBinderFactory f) {
                return current;
            }
        };
        var contentController = new ExamContentAdminController(mock(ExamContentPackageValidator.class), importer, content, permissions,
                bootstrap, new ExamsProperties(), validation, practice, identity);
        org.springframework.test.util.ReflectionTestUtils.setField(contentController, "corpusPracticeRelease", corpusRelease);
        mvc = MockMvcBuilders.standaloneSetup(
                        new ExamAdminController(publication, permissions, results, identity),
                        contentController,
                        new ExamMeasurementController(new ExamMeasurementAuthorizationService(permissions), measurement,
                                mock(ExamCalibrationService.class), mock(ExamRaterService.class)))
                .setControllerAdvice(new ExamExceptionHandler())
                .setCustomArgumentResolvers(principal).build();
    }

    static final UUID FORM = UUID.fromString("00000000-0000-0000-0000-00000000f001");

    /** Every admin endpoint of the Exams module (mutations first). */
    static List<RequestBuilder> adminCalls() {
        String review = "{\"gate\":\"CONTENT_QA\",\"decision\":\"APPROVED\",\"hash\":\"h\",\"notes\":\"n\"}";
        String consent = "{\"status\":\"GRANTED\",\"consentHash\":\"c\"}";
        return List.of(
                post("/api/v1/admin/exams/forms/" + FORM + "/publish"),
                post("/api/v1/admin/exams/forms/" + FORM + "/retire"),
                post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON).content(review),
                post("/api/v1/admin/exams/review-cases/" + FORM + "/decisions").contentType(MediaType.APPLICATION_JSON).content("{\"d\":1}"),
                get("/api/v1/admin/exams/review-cases"),
                post("/api/v1/admin/exams/content-packages/bootstrap"),
                post("/api/v1/admin/exams/content-packages/release-qualified-corpus-practice"),
                post("/api/v1/admin/exams/content-packages/release-qualified-corpus-practice").contentType(MediaType.APPLICATION_JSON).content("{}"),
                post("/api/v1/admin/exams/content-packages/import").contentType(MediaType.APPLICATION_JSON).content("{}"),
                post("/api/v1/admin/exams/content-packages/private-drafts").contentType(MediaType.APPLICATION_JSON).content("{}"),
                post("/api/v1/admin/exams/content-packages/forms/" + FORM + "/release-original-bank-practice"),
                get("/api/v1/admin/exams/content-packages/private-drafts/pkg/1"),
                post("/api/v1/admin/exams/content-packages/validate").contentType(MediaType.APPLICATION_JSON).content("{}"),
                post("/api/v1/admin/exams/content-packages/forms/" + FORM + "/validation"),
                get("/api/v1/admin/exams/content-packages/forms/" + FORM + "/validation"),
                get("/api/v1/admin/exams/content-packages/forms/" + FORM + "/practice-scopes"),
                get("/api/v1/admin/exams/content-packages/forms"),
                get("/api/v1/admin/exams/content-packages/sources"),
                get("/api/v1/admin/exams/content-packages/pkg/1"),
                post("/api/v1/admin/exams/measurement/consent").contentType(MediaType.APPLICATION_JSON).content(consent),
                post("/api/v1/admin/exams/measurement/consent/human-rating").contentType(MediaType.APPLICATION_JSON).content(consent),
                post("/api/v1/admin/exams/measurement/attempts/" + FORM + "/collect"));
    }

    private void verifyNoServiceReached() {
        verifyNoInteractions(publication, results, importer, bootstrap, validation, practice, measurement, corpusRelease);
        verify(content, never()).getAdminFormSummaries(any(), any(), anyInt(), anyInt());
        verify(content, never()).getAdminSourceSummaries(anyInt(), anyInt());
    }

    @Test
    @DisplayName("01-05: a normal learner gets 403 on every Exams admin endpoint (publish, retire, review, review case, "
            + "content-package import / bootstrap / validate / revalidate, diagnostics, measurement) — no service reached")
    void learnerDeniedEverywhere() throws Exception {
        current = LEARNER;
        for (RequestBuilder call : adminCalls()) {
            MvcResult r = mvc.perform(call).andReturn();
            assertEquals(403, r.getResponse().getStatus(), "learner must be refused: " + call);
            assertFalse(r.getResponse().getContentAsString().contains("Exception"), "no internals: " + call);
        }
        verifyNoServiceReached();
    }

    @Test
    @DisplayName("anonymous (no principal) is refused (401 / 403) on every admin endpoint — no service reached")
    void anonymousDeniedEverywhere() throws Exception {
        current = null;
        for (RequestBuilder call : adminCalls()) {
            int s = mvc.perform(call).andReturn().getResponse().getStatus();
            assertTrue(s == 401 || s == 403, "anonymous must be refused: " + call + " → " + s);
        }
        verifyNoServiceReached();
    }

    @Test
    @DisplayName("06: the official admin reaches publish / retire / review / review cases / content diagnostics")
    void officialAdminAllowed() throws Exception {
        current = ADMIN;
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/publish")).andExpect(status().isOk());
        verify(publication).publishForm(eq(FORM), eq(1L), anyString());
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/retire")).andExpect(status().isOk());
        verify(publication).retireForm(eq(FORM), eq(1L), anyString());
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON)
                .content("{\"gate\":\"CONTENT_QA\",\"decision\":\"APPROVED\",\"hash\":\"abc\"}")).andExpect(status().isOk());
        verify(publication).submitReview(FORM, ReviewGate.CONTENT_QA, 1L, ReviewDecision.APPROVED, "abc", "");
        mvc.perform(get("/api/v1/admin/exams/review-cases").param("limit", "100000")).andExpect(status().isOk());
        verify(results).findOpenReviewCases(100, 0);
        when(content.getAdminFormSummaries(any(), any(), anyInt(), anyInt())).thenReturn(List.of());
        mvc.perform(get("/api/v1/admin/exams/content-packages/forms")).andExpect(status().isOk());
    }

    @Test
    void qualifiedCorpusReleaseUsesAuthenticatedActorAndSanitizesFailure() throws Exception {
        current = ADMIN;
        when(corpusRelease.releaseQualifiedPackage(1L,0)).thenReturn(List.of(Map.of("operation", "CREATE")));
        mvc.perform(post("/api/v1/admin/exams/content-packages/release-qualified-corpus-practice"))
                .andExpect(status().isOk()).andExpect(jsonPath("$[0].operation").value("CREATE"));
        verify(corpusRelease).releaseQualifiedPackage(1L,0);
        when(corpusRelease.releaseQualifiedPackage(1L,0)).thenThrow(new java.io.IOException("private storage details"));
        var failed = mvc.perform(post("/api/v1/admin/exams/content-packages/release-qualified-corpus-practice"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CORPUS_PRACTICE_RELEASE_UNAVAILABLE")).andReturn();
        assertFalse(failed.getResponse().getContentAsString().contains("private storage details"));
    }

    @Test
    @DisplayName("07/09: submitReview without a closure hash is refused (400 REVIEW_CLOSURE_HASH_REQUIRED) — no default hash")
    void missingFingerprintRejected() throws Exception {
        current = ADMIN;
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"gate\":\"CONTENT_QA\",\"decision\":\"APPROVED\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("REVIEW_CLOSURE_HASH_REQUIRED"));
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"gate\":\"CONTENT_QA\",\"decision\":\"APPROVED\",\"hash\":\"  \"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("REVIEW_CLOSURE_HASH_REQUIRED"));
        MvcResult bad = mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON)
                .content("{\"gate\":\"NOPE\",\"decision\":\"APPROVED\",\"hash\":\"h\"}")).andExpect(status().isBadRequest()).andReturn();
        assertFalse(bad.getResponse().getContentAsString().contains("com.englishcoach"), "no Java class name in the error");
        verifyNoInteractions(publication);
        // the hard-coded fallback is gone from the whole Exams source tree
        try (var files = Files.walk(SRC.resolve("exams"))) {
            for (Path f : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                assertFalse(Files.readString(f).contains("v1_closure_hash"), "fallback closure hash in " + f);
            }
        }
    }

    @Test
    @DisplayName("08: a stale or unknown closure is refused by the service; nothing is recorded")
    void staleFingerprintRejected() {
        ExamContentRepository repo = mock(ExamContentRepository.class);
        ExamRightsService rights = mock(ExamRightsService.class);
        FormVersionRecord form = new FormVersionRecord(FORM, "K", 1, "T", ExamFamily.TOEIC, "LR", "FULL", null, null, null,
                LifecycleState.DRAFT, null, 42L, "current", null, null, Instant.now(), null);
        when(repo.findFormById(FORM)).thenReturn(Optional.of(form));
        ExamPublicationService service = new ExamPublicationService(repo, rights);
        when(repo.findCurrentClosureHash(FORM)).thenReturn(Optional.of("current"));
        IllegalStateException stale = assertThrows(IllegalStateException.class,
                () -> service.submitReview(FORM, ReviewGate.CONTENT_QA, 1L, ReviewDecision.APPROVED, "older", "n"));
        assertTrue(stale.getMessage().startsWith("STALE_REVIEW_HASH"));
        when(repo.findCurrentClosureHash(FORM)).thenReturn(Optional.empty());
        IllegalStateException unknown = assertThrows(IllegalStateException.class,
                () -> service.submitReview(FORM, ReviewGate.CONTENT_QA, 1L, ReviewDecision.APPROVED, "anything", "n"));
        assertTrue(unknown.getMessage().startsWith("REVIEW_CLOSURE_UNAVAILABLE"));
        verify(repo, never()).insertContentReview(any(), any(), any(), any(), any(), any());
        verify(repo, never()).updateFormLifecycle(any(), any(), any(), any());
    }

    @Test
    @DisplayName("10: the reviewer recorded is the authenticated principal — a client-sent reviewer field is ignored")
    void reviewerFromServerContext() throws Exception {
        current = ADMIN;
        mvc.perform(post("/api/v1/admin/exams/forms/" + FORM + "/reviews").contentType(MediaType.APPLICATION_JSON)
                .content("{\"gate\":\"ANSWER_QA\",\"decision\":\"REJECTED\",\"hash\":\"h\",\"reviewer\":\"999\",\"reviewerUserId\":\"999\"}"))
                .andExpect(status().isOk());
        verify(publication).submitReview(FORM, ReviewGate.ANSWER_QA, 1L, ReviewDecision.REJECTED, "h", "");
    }

    @Test
    @DisplayName("permission service: the official admin is decided by the users row of the CHECKED id, not the request authority")
    void permissionServiceUsesIdentity() {
        NamedParameterJdbcTemplate jdbc = mock(NamedParameterJdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), any(org.springframework.jdbc.core.namedparam.SqlParameterSource.class), eq(Integer.class)))
                .thenReturn(0);
        ExamPermissionService p = new ExamPermissionService(jdbc, identity);
        // a request that carries ROLE_ADMIN does not lend the privilege to another user id
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken("x", null,
                        List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_ADMIN"))));
        try {
            assertTrue(p.hasOperatorPermission(1L, "EXAMS_PUBLISH"));
            assertFalse(p.hasOperatorPermission(676L, "EXAMS_PUBLISH"));
            assertFalse(p.hasOperatorPermission(null, "EXAMS_PUBLISH"));
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
        }
    }

    @Test
    @DisplayName("URL rule: /api/v1/admin/** requires ROLE_ADMIN in the security chain (first layer)")
    void urlRuleProtectsAdmin() throws Exception {
        String security = Files.readString(SRC.resolve("common/security/WebSecurityConfig.java"));
        assertTrue(security.contains(".requestMatchers(\"/api/v1/admin/**\", \"/api/v1/feedback/admin/**\").hasRole(\"ADMIN\")"));
        // every admin controller of the module re-checks the official administrator server-side (second layer)
        for (String c : List.of("exams/controller/ExamAdminController.java", "exams/controller/ExamContentAdminController.java",
                "exams/controller/ExamOperationsController.java")) {
            assertTrue(Files.readString(SRC.resolve(c)).contains("isOfficialAdmin"), c);
        }
        String measurement = Files.readString(SRC.resolve("exams/measurement/controller/ExamMeasurementController.java"));
        int endpoints = measurement.split("@(Get|Post)Mapping\\(").length - 1;
        int checks = measurement.split("authorization\\.require\\(").length - 1;
        assertEquals(endpoints, checks, "every measurement endpoint re-checks an Exams operator permission");
    }
}
