package com.englishcoach.echocoach.controller;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachMessageDto;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.service.EchoCoachService;
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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class EchoCoachControllerTest {

    @Mock
    private EchoCoachService echoCoachService;

    @InjectMocks
    private EchoCoachController echoCoachController;

    private MockMvc mockMvc;
    private ObjectMapper objectMapper;
    private UserDetailsImpl userPrincipal;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        objectMapper.findAndRegisterModules();

        User user = User.builder()
                .id(1L)
                .email("learner@englishcoach.com")
                .name("Learner")
                .role(Role.ROLE_USER)
                .build();
        userPrincipal = UserDetailsImpl.build(user);

        mockMvc = MockMvcBuilders.standaloneSetup(echoCoachController)
                .setCustomArgumentResolvers(new HandlerMethodArgumentResolver() {
                    @Override
                    public boolean supportsParameter(MethodParameter parameter) {
                        return parameter.hasParameterAnnotation(AuthenticationPrincipal.class)
                                && parameter.getParameterType().isAssignableFrom(UserDetailsImpl.class);
                    }

                    @Override
                    public Object resolveArgument(MethodParameter parameter,
                                                  ModelAndViewContainer mavContainer,
                                                  NativeWebRequest webRequest,
                                                  WebDataBinderFactory binderFactory) {
                        return userPrincipal;
                    }
                })
                .build();
    }

    @Test
    @DisplayName("GET /api/v1/echo-coach/sessions returns list of up to 15 recent sessions")
    void testGetRecentSessions() throws Exception {
        EchoCoachSessionDto s1 = new EchoCoachSessionDto(1L, "Session 1", Instant.now(), Instant.now());
        EchoCoachSessionDto s2 = new EchoCoachSessionDto(2L, "Session 2", Instant.now(), Instant.now());

        when(echoCoachService.getRecentSessions(1L)).thenReturn(List.of(s1, s2));

        mockMvc.perform(get("/api/v1/echo-coach/sessions"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].id").value(1))
                .andExpect(jsonPath("$[0].title").value("Session 1"));

        verify(echoCoachService).getRecentSessions(1L);
    }

    @Test
    @DisplayName("POST /api/v1/echo-coach/sessions creates a new session")
    void testCreateSession() throws Exception {
        CreateSessionRequest request = new CreateSessionRequest("Chủ đề IELTS Speaking");
        EchoCoachSessionDto created = new EchoCoachSessionDto(5L, "Chủ đề IELTS Speaking", Instant.now(), Instant.now());

        when(echoCoachService.createSession(eq(1L), any(CreateSessionRequest.class))).thenReturn(created);

        mockMvc.perform(post("/api/v1/echo-coach/sessions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(5))
                .andExpect(jsonPath("$.title").value("Chủ đề IELTS Speaking"));
    }

    @Test
    @DisplayName("GET /api/v1/echo-coach/sessions/{id}/messages returns conversation messages")
    void testGetSessionMessages() throws Exception {
        EchoCoachMessageDto m1 = new EchoCoachMessageDto(10L, 5L, "user", "Xin chào", Instant.now());
        EchoCoachMessageDto m2 = new EchoCoachMessageDto(11L, 5L, "assistant", "Chào bạn!", Instant.now());

        when(echoCoachService.getSessionMessages(1L, 5L)).thenReturn(List.of(m1, m2));

        mockMvc.perform(get("/api/v1/echo-coach/sessions/5/messages"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].role").value("user"))
                .andExpect(jsonPath("$[1].role").value("assistant"));
    }

    @Test
    @DisplayName("POST /api/v1/echo-coach/sessions/{id}/messages persists new message pair")
    void testSaveMessages() throws Exception {
        SaveMessagePairRequest request = new SaveMessagePairRequest(
                "Cách dùng câu điều kiện loại 3?",
                "Câu điều kiện loại 3 dùng để diễn tả một hành động không có thật trong quá khứ.",
                null,
                null
        );

        EchoCoachMessageDto m1 = new EchoCoachMessageDto(20L, 5L, "user", request.userMessage(), Instant.now());
        EchoCoachMessageDto m2 = new EchoCoachMessageDto(21L, 5L, "assistant", request.assistantMessage(), Instant.now());

        when(echoCoachService.saveMessages(eq(1L), eq(5L), any(SaveMessagePairRequest.class)))
                .thenReturn(List.of(m1, m2));

        mockMvc.perform(post("/api/v1/echo-coach/sessions/5/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].content").value(request.userMessage()));
    }

    @Test
    @DisplayName("DELETE /api/v1/echo-coach/sessions/{id} returns 204 No Content")
    void testDeleteSession() throws Exception {
        mockMvc.perform(delete("/api/v1/echo-coach/sessions/5"))
                .andExpect(status().isNoContent());

        verify(echoCoachService).deleteSession(1L, 5L);
    }
}
