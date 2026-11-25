package com.englishcoach.exams.hardening;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.controller.ExamPracticeController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.exception.ExamWriteClosedException;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.security.ExamRateLimiter;
import com.englishcoach.exams.service.ExamDeadlinePolicy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.util.Collections;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * Exams Phase 9F — safe public errors (matrix 55–58) and rate limiting through the EXISTING shared store (53–55).
 */
class ExamPhase9ErrorAndRateLimitTest {

    /** Throws the configured exception on every call: proves what the exams advice turns it into. */
    @RestController
    static class Thrower {
        RuntimeException next;

        @GetMapping("/api/v1/exams/__probe")
        public String probe() {
            throw next;
        }

        @PostMapping("/api/v1/exams/__body")
        public String body(@RequestBody java.util.Map<String, Object> m) {
            return "ok";
        }
    }

    static String bodyOf(MockMvc mvc, Thrower t, RuntimeException e, int expectedStatus) throws Exception {
        t.next = e;
        MvcResult r = mvc.perform(get("/api/v1/exams/__probe")).andReturn();
        assertEquals(expectedStatus, r.getResponse().getStatus(), e.toString());
        return r.getResponse().getContentAsString();
    }

    @Test
    @DisplayName("56/57/58: no stack trace, SQL, Java class name or file path in a public Exams error")
    void safeErrors() throws Exception {
        Thrower t = new Thrower();
        MockMvc mvc = MockMvcBuilders.standaloneSetup(t).setControllerAdvice(new ExamExceptionHandler()).build();
        List<String> leaks = List.of("SELECT", "exams.attempts", "com.englishcoach", "java.lang", "C:\\", "/app/", "Exception",
                "at org.", "No enum constant");
        String[] bodies = {
                bodyOf(mvc, t, new IllegalArgumentException("No enum constant com.englishcoach.exams.model.ExamTypes.ReviewGate.FOO"), 400),
                bodyOf(mvc, t, new IllegalStateException("ERROR: SELECT * FROM exams.attempts WHERE id = 1 failed"), 409),
                bodyOf(mvc, t, new IllegalStateException("cannot read C:\\My Workspace\\imports\\source-files\\x.pdf"), 409),
                bodyOf(mvc, t, new RuntimeException("org.postgresql.util.PSQLException: relation exams.attempts does not exist"), 500),
                bodyOf(mvc, t, new NullPointerException("Cannot invoke java.lang.String.trim()"), 500),
                bodyOf(mvc, t, new NumberFormatException("For input string: \"abc\""), 400),
        };
        for (String b : bodies) for (String leak : leaks) assertFalse(b.contains(leak), "leak '" + leak + "' in " + b);
        // our own stable messages still pass through
        String own = bodyOf(mvc, t, new IllegalStateException("PUBLICATION_STATE_INVALID: Form must complete legal QA before publication"), 409);
        assertTrue(own.contains("PUBLICATION_STATE_INVALID"));
        // malformed JSON body ⇒ 400 generic, never a parser message
        MvcResult bad = mvc.perform(post("/api/v1/exams/__body").contentType(MediaType.APPLICATION_JSON).content("{not json")).andReturn();
        assertEquals(400, bad.getResponse().getStatus());
        assertFalse(bad.getResponse().getContentAsString().contains("JSON parse error"));
        assertFalse(bad.getResponse().getContentAsString().contains("com.fasterxml"));
    }

    @Test
    @DisplayName("a closed-attempt write is a terminal 409 (retryable=false) with a stable code and learner text")
    void writeClosedIsTerminal() throws Exception {
        Thrower t = new Thrower();
        MockMvc mvc = MockMvcBuilders.standaloneSetup(t).setControllerAdvice(new ExamExceptionHandler()).build();
        String b = bodyOf(mvc, t, new ExamWriteClosedException(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED, "Attempt x passed", 4L), 409);
        assertTrue(b.contains("\"code\":\"ATTEMPT_DEADLINE_PASSED\""));
        assertTrue(b.contains("\"retryable\":false"));
        assertFalse(b.contains("Attempt x passed"), "internal message stays in the log");
    }

    @Test
    @DisplayName("53/55: throttled Practice creation ⇒ 429 RATE_LIMITED + Retry-After, no limiter internals, service never called")
    void rateLimited() throws Exception {
        LoginThrottleService store = mock(LoginThrottleService.class);
        when(store.checkAndIncrementRateLimit(eq("EXAMS_CREATE_PRACTICE_ATTEMPT"), eq("user:5"), anyInt(), eq(1))).thenReturn(false);
        ExamPracticeService practice = mock(ExamPracticeService.class);
        UserDetailsImpl user = new UserDetailsImpl(5L, "l@example.test", "p", Collections.emptyList());
        HandlerMethodArgumentResolver principal = new HandlerMethodArgumentResolver() {
            public boolean supportsParameter(MethodParameter p) {
                return p.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            public Object resolveArgument(MethodParameter p, ModelAndViewContainer m, NativeWebRequest r, WebDataBinderFactory f) {
                return user;
            }
        };
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ExamPracticeController(practice, new ExamRateLimiter(store)))
                .setControllerAdvice(new ExamExceptionHandler()).setCustomArgumentResolvers(principal).build();
        MvcResult r = mvc.perform(post("/api/v1/exams/practice/attempts").contentType(MediaType.APPLICATION_JSON)
                .content("{\"formId\":\"" + UUID.randomUUID() + "\",\"scopeCode\":\"TOEIC_PART_5\"}")).andReturn();
        assertEquals(429, r.getResponse().getStatus());
        assertEquals("60", r.getResponse().getHeader("Retry-After"));
        String b = r.getResponse().getContentAsString();
        assertTrue(b.contains("\"code\":\"RATE_LIMITED\""));
        assertFalse(b.contains("EXAMS_CREATE_PRACTICE_ATTEMPT") || b.contains("auth_rate_limit") || b.contains("user:5"));
        verifyNoInteractions(practice);
    }

    @Test
    @DisplayName("54: limits stay far above legitimate use; the store failing never blocks a learner; autosave / submit are not throttled")
    void limiterPolicy() throws Exception {
        for (ExamRateLimiter.Operation op : ExamRateLimiter.Operation.values()) assertTrue(op.perMinute >= 20, op.name());
        assertTrue(ExamRateLimiter.Operation.PLAYBACK_GRANT.perMinute >= 100, "a TOEIC part playlist needs several grants");
        LoginThrottleService broken = mock(LoginThrottleService.class);
        when(broken.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenThrow(new RuntimeException("db down"));
        assertDoesNotThrow(() -> new ExamRateLimiter(broken).check(ExamRateLimiter.Operation.ANALYTICS, 5L));
        assertDoesNotThrow(() -> ExamRateLimiter.disabled().check(ExamRateLimiter.Operation.ANALYTICS, 5L));
        String attemptController = java.nio.file.Files.readString(java.nio.file.Path.of(
                "src/main/java/com/englishcoach/exams/controller/ExamAttemptController.java"));
        int save = attemptController.indexOf("public ResponseEntity<SaveReceiptDto> saveResponses");
        int submit = attemptController.indexOf("public ResponseEntity<Map<String, Object>> submitAttempt");
        int complete = attemptController.indexOf("@PostMapping(\"/attempts/{id}/sections/{sectionId}/complete\")");
        assertFalse(attemptController.substring(save, complete).contains("rateLimiter"), "autosave / submit never throttled");
        assertTrue(save > 0 && submit > save);
    }
}
