package com.englishcoach.exams;

import com.englishcoach.common.exception.GlobalExceptionHandler;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.controller.ExamAdminController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.model.ExamTypes.ReviewDecision;
import com.englishcoach.exams.model.ExamTypes.ReviewGate;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamPublicationService;
import com.englishcoach.exams.service.ExamResultService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.util.Collections;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@ExtendWith(MockitoExtension.class)
class ExamAdminControllerTest {

    @Mock
    private ExamPublicationService publicationService;

    @Mock
    private ExamPermissionService permissionService;

    @Mock
    private ExamResultService resultService;

    /** Exams Phase 9A: the controller re-checks the official administrator (user 1 here) before any service call. */
    @Mock
    private com.englishcoach.auth.policy.AdminIdentityService adminIdentity;

    @InjectMocks
    private ExamAdminController controller;

    private MockMvc mockMvc;

    private final UserDetailsImpl testUser = new UserDetailsImpl(1L, "admin@englishcoach.com", "pass", Collections.emptyList());

    private final HandlerMethodArgumentResolver authPrincipalResolver = new HandlerMethodArgumentResolver() {
        @Override
        public boolean supportsParameter(MethodParameter parameter) {
            return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
        }

        @Override
        public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                      NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
            return testUser;
        }
    };

    @BeforeEach
    void setUp() {
        lenient().when(adminIdentity.isOfficialAdmin(1L)).thenReturn(true);
        // Standalone setup sorts advices by @Order.
        // ExamExceptionHandler has @Order(Ordered.HIGHEST_PRECEDENCE),
        // GlobalExceptionHandler has @Order(Ordered.LOWEST_PRECEDENCE).
        mockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setCustomArgumentResolvers(authPrincipalResolver)
                .setControllerAdvice(new ExamExceptionHandler(), new GlobalExceptionHandler())
                .build();
    }

    @Test
    @DisplayName("Publication rejection: draft lifecycle returns controlled 409 CONFLICT (not 500)")
    void publishFormReturnsConflictOnInvalidPublicationState() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("PUBLICATION_STATE_INVALID: Form must complete legal QA before publication"))
                .when(publicationService).publishForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("STATE_CONFLICT"))
                .andExpect(jsonPath("$.message").value("PUBLICATION_STATE_INVALID: Form must complete legal QA before publication"));
    }

    @Test
    @DisplayName("Publication rejection: incomplete review gates return 409 CONFLICT (not 500)")
    void publishFormReturnsConflictOnIncompleteReviews() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("PUBLICATION_REVIEW_GATES_INCOMPLETE: Three exact-hash gates and two independent human reviewers are required"))
                .when(publicationService).publishForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("STATE_CONFLICT"))
                .andExpect(jsonPath("$.message").value("PUBLICATION_REVIEW_GATES_INCOMPLETE: Three exact-hash gates and two independent human reviewers are required"));
    }

    @Test
    @DisplayName("Publication rejection: rights verification failed returns 409 CONFLICT (not 500)")
    void publishFormReturnsConflictOnRightsVerificationFailed() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("RIGHTS_VERIFICATION_FAILED: Content rights incomplete or invalid"))
                .when(publicationService).publishForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("STATE_CONFLICT"))
                .andExpect(jsonPath("$.message").value("RIGHTS_VERIFICATION_FAILED: Content rights incomplete or invalid"));
    }

    @Test
    @DisplayName("Publication rejection: publisher lacking permission returns 403 FORBIDDEN (not 500)")
    void publishFormReturnsForbiddenOnPermissionRequired() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED: Publisher lacks EXAMS_PUBLISH permission"))
                .when(publicationService).publishForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"))
                .andExpect(jsonPath("$.message").value("CONTENT_PUBLISH_PERMISSION_REQUIRED: Publisher lacks EXAMS_PUBLISH permission"));
    }

    private final HandlerMethodArgumentResolver unauthPrincipalResolver = new HandlerMethodArgumentResolver() {
        @Override
        public boolean supportsParameter(MethodParameter parameter) {
            return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
        }

        @Override
        public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                      NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
            return null;
        }
    };

    @Test
    @DisplayName("Publication rejection: unauthenticated request returns 401 UNAUTHORIZED")
    void publishFormReturnsUnauthorizedWhenUnauthenticated() throws Exception {
        MockMvc unauthMockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setCustomArgumentResolvers(unauthPrincipalResolver)
                .setControllerAdvice(new ExamExceptionHandler(), new GlobalExceptionHandler())
                .build();

        UUID formId = UUID.randomUUID();
        unauthMockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("Publication success: eligible form publishes successfully with 200 OK")
    void publishFormSucceedsWhenEligible() throws Exception {
        UUID formId = UUID.randomUUID();
        doNothing().when(publicationService).publishForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/publish")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.formId").value(formId.toString()))
                .andExpect(jsonPath("$.status").value("PUBLISHED"));

        verify(publicationService).publishForm(eq(formId), eq(1L), eq("Publication gate approved by content operations"));
    }

    @Test
    @DisplayName("Review rejection: stale review hash returns 409 CONFLICT (not 500)")
    void submitReviewReturnsConflictOnStaleHash() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("STALE_REVIEW_HASH: Review was produced for a different content closure"))
                .when(publicationService).submitReview(eq(formId), eq(ReviewGate.CONTENT_QA), eq(1L), eq(ReviewDecision.APPROVED), any(), any());

        String body = """
            {
                "gate": "CONTENT_QA",
                "decision": "APPROVED",
                "hash": "wrong_hash",
                "notes": "Looks good"
            }
        """;

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/reviews")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("STATE_CONFLICT"))
                .andExpect(jsonPath("$.message").value("STALE_REVIEW_HASH: Review was produced for a different content closure"));
    }

    @Test
    @DisplayName("Review rejection: author self-review returns 403 FORBIDDEN (not 500)")
    void submitReviewReturnsForbiddenOnSelfReview() throws Exception {
        UUID formId = UUID.randomUUID();
        doThrow(new IllegalStateException("AUTHOR_SELF_REVIEW_FORBIDDEN: Author cannot review their own form"))
                .when(publicationService).submitReview(eq(formId), eq(ReviewGate.CONTENT_QA), eq(1L), eq(ReviewDecision.APPROVED), any(), any());

        String body = """
            {
                "gate": "CONTENT_QA",
                "decision": "APPROVED",
                "hash": "valid_hash",
                "notes": "Self review"
            }
        """;

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/reviews")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"))
                .andExpect(jsonPath("$.message").value("AUTHOR_SELF_REVIEW_FORBIDDEN: Author cannot review their own form"));
    }

    @Test
    @DisplayName("Review success: valid review returns 200 OK")
    void submitReviewSucceeds() throws Exception {
        UUID formId = UUID.randomUUID();
        doNothing().when(publicationService).submitReview(eq(formId), eq(ReviewGate.CONTENT_QA), eq(1L), eq(ReviewDecision.APPROVED), eq("hash123"), eq("LGTM"));

        String body = """
            {
                "gate": "CONTENT_QA",
                "decision": "APPROVED",
                "hash": "hash123",
                "notes": "LGTM"
            }
        """;

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/reviews")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.formId").value(formId.toString()))
                .andExpect(jsonPath("$.gate").value("CONTENT_QA"))
                .andExpect(jsonPath("$.decision").value("APPROVED"));
    }

    @Test
    @DisplayName("Retire form success: returns 200 OK")
    void retireFormSucceeds() throws Exception {
        UUID formId = UUID.randomUUID();
        doNothing().when(publicationService).retireForm(eq(formId), eq(1L), any());

        mockMvc.perform(post("/api/v1/admin/exams/forms/" + formId + "/retire")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.formId").value(formId.toString()))
                .andExpect(jsonPath("$.status").value("RETIRED"));
    }
}
