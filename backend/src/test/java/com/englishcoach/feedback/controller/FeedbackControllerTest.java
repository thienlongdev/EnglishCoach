package com.englishcoach.feedback.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.feedback.dto.*;
import com.englishcoach.feedback.service.FeedbackService;
import com.fasterxml.jackson.databind.ObjectMapper;
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

import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class FeedbackControllerTest {

    @Mock
    private FeedbackService feedbackService;

    @InjectMocks
    private FeedbackController feedbackController;

    private MockMvc mockMvc;
    private ObjectMapper objectMapper;

    private UserDetailsImpl userPrincipal;
    private UserDetailsImpl adminPrincipal;
    private UserDetailsImpl currentPrincipal;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();

        User student = User.builder()
                .id(1L)
                .email("student@englishcoach.com")
                .name("Student")
                .role(Role.ROLE_USER)
                .build();
        userPrincipal = UserDetailsImpl.build(student);

        User admin = User.builder()
                .id(99L)
                .email("admin@englishcoach.com")
                .name("Admin")
                .role(Role.ROLE_ADMIN)
                .build();
        adminPrincipal = UserDetailsImpl.build(admin);

        HandlerMethodArgumentResolver principalResolver = new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter,
                                          ModelAndViewContainer mavContainer,
                                          NativeWebRequest webRequest,
                                          WebDataBinderFactory binderFactory) {
                return currentPrincipal;
            }
        };

        mockMvc = MockMvcBuilders.standaloneSetup(feedbackController)
                .setCustomArgumentResolvers(principalResolver)
                .build();
    }

    @Test
    @DisplayName("Learner can create feedback thread (201 Created)")
    void testLearnerCreateThread() throws Exception {
        currentPrincipal = userPrincipal;

        FeedbackThreadDto responseDto = new FeedbackThreadDto(
                1L, 1L, "Student", "student@englishcoach.com",
                "IDEA", "Thêm dark mode", "OPEN", true, false,
                Instant.now(), Instant.now(), "Nội dung"
        );
        when(feedbackService.createThread(eq(1L), any())).thenReturn(responseDto);

        CreateFeedbackRequest request = new CreateFeedbackRequest("IDEA", "Thêm dark mode", "Nội dung chi tiết");

        mockMvc.perform(post("/api/v1/feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(1L))
                .andExpect(jsonPath("$.subject").value("Thêm dark mode"));
    }

    @Test
    @DisplayName("Admin is forbidden from creating learner feedback (403 Forbidden)")
    void testAdminCreateFeedbackForbidden() throws Exception {
        currentPrincipal = adminPrincipal;

        CreateFeedbackRequest request = new CreateFeedbackRequest("IDEA", "Tiêu đề", "Nội dung");

        mockMvc.perform(post("/api/v1/feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("Admin can view inbox (200 OK)")
    void testAdminViewInbox() throws Exception {
        currentPrincipal = adminPrincipal;

        FeedbackThreadDto threadDto = new FeedbackThreadDto(
                1L, 1L, "Student", "student@englishcoach.com",
                "BUG", "Lỗi loa", "OPEN", true, false,
                Instant.now(), Instant.now(), "Loa rè"
        );
        when(feedbackService.getAdminInbox()).thenReturn(List.of(threadDto));

        mockMvc.perform(get("/api/v1/feedback/admin/inbox"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].subject").value("Lỗi loa"));
    }

    @Test
    @DisplayName("Learner is forbidden from accessing admin inbox (403 Forbidden)")
    void testLearnerAdminInboxForbidden() throws Exception {
        currentPrincipal = userPrincipal;

        mockMvc.perform(get("/api/v1/feedback/admin/inbox"))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("Learner can send follow-up message (201 Created)")
    void testLearnerFollowUp() throws Exception {
        currentPrincipal = userPrincipal;

        Instant now = Instant.now();
        FeedbackMessageDto messageDto = new FeedbackMessageDto(
                15L, 1L, 1L, "Student", false, "Học viên hỏi thêm", now
        );
        when(feedbackService.userFollowUp(eq(1L), eq(1L), any())).thenReturn(messageDto);

        FeedbackMessageRequest request = new FeedbackMessageRequest("Học viên hỏi thêm");

        mockMvc.perform(post("/api/v1/feedback/1/follow-up")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(15L))
                .andExpect(jsonPath("$.threadId").value(1L))
                .andExpect(jsonPath("$.senderUserId").value(1L))
                .andExpect(jsonPath("$.senderName").value("Student"))
                .andExpect(jsonPath("$.fromAdmin").value(false))
                .andExpect(jsonPath("$.content").value("Học viên hỏi thêm"))
                .andExpect(jsonPath("$.createdAt").isNotEmpty());
    }

    @Test
    @DisplayName("Admin is forbidden from user follow-up endpoint (403 Forbidden)")
    void testAdminUserFollowUpForbidden() throws Exception {
        currentPrincipal = adminPrincipal;

        FeedbackMessageRequest request = new FeedbackMessageRequest("Admin thử gửi");

        mockMvc.perform(post("/api/v1/feedback/1/follow-up")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("Admin can reply to feedback thread (201 Created)")
    void testAdminReply() throws Exception {
        currentPrincipal = adminPrincipal;

        Instant now = Instant.now();
        FeedbackMessageDto replyDto = new FeedbackMessageDto(
                10L, 1L, 99L, "Admin EnglishCoach", true, "Đã phản hồi", now
        );
        when(feedbackService.adminReply(eq(99L), eq(1L), any())).thenReturn(replyDto);

        FeedbackMessageRequest request = new FeedbackMessageRequest("Đã phản hồi");

        mockMvc.perform(post("/api/v1/feedback/admin/1/reply")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(10L))
                .andExpect(jsonPath("$.threadId").value(1L))
                .andExpect(jsonPath("$.senderUserId").value(99L))
                .andExpect(jsonPath("$.senderName").value("Admin EnglishCoach"))
                .andExpect(jsonPath("$.fromAdmin").value(true))
                .andExpect(jsonPath("$.content").value("Đã phản hồi"))
                .andExpect(jsonPath("$.createdAt").isNotEmpty());
    }

    @Test
    @DisplayName("Learner is forbidden from admin reply endpoint (403 Forbidden)")
    void testLearnerAdminReplyForbidden() throws Exception {
        currentPrincipal = userPrincipal;

        FeedbackMessageRequest request = new FeedbackMessageRequest("Hack");

        mockMvc.perform(post("/api/v1/feedback/admin/1/reply")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("Admin can close feedback thread (200 OK)")
    void testAdminCloseThread() throws Exception {
        currentPrincipal = adminPrincipal;

        FeedbackThreadDto closedDto = new FeedbackThreadDto(
                1L, 1L, "Student", "student@englishcoach.com",
                "BUG", "Lỗi loa", "CLOSED", false, false,
                Instant.now(), Instant.now(), ""
        );
        when(feedbackService.closeThread(1L)).thenReturn(closedDto);

        mockMvc.perform(patch("/api/v1/feedback/admin/1/close"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CLOSED"));
    }

    @Test
    @DisplayName("Learner is forbidden from closing feedback thread (403 Forbidden)")
    void testLearnerCloseThreadForbidden() throws Exception {
        currentPrincipal = userPrincipal;

        mockMvc.perform(patch("/api/v1/feedback/admin/1/close"))
                .andExpect(status().isForbidden());
    }
}
