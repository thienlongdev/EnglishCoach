package com.englishcoach.ai;

import com.englishcoach.ai.controller.AiChatController;
import com.englishcoach.ai.dto.AiChatMessageDto;
import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.common.security.UserDetailsImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

class AiChatControllerTest {

    private AiChatService aiChatService;
    private AiChatController controller;

    @BeforeEach
    void setUp() {
        aiChatService = Mockito.mock(AiChatService.class);
        controller = new AiChatController(aiChatService);
    }

    @Test
    @DisplayName("Authenticated Chat: returns 200 OK with AI response")
    void chat_authenticatedUser_returnsOkResponse() {
        UserDetailsImpl userDetails = new UserDetailsImpl(
                42L,
                "thienlong@example.com",
                "encoded_pw",
                Collections.emptyList()
        );

        AiChatRequest request = new AiChatRequest(List.of(
                new AiChatMessageDto("user", "pass ielts")
        ));

        when(aiChatService.chat(eq(42L), any(AiChatRequest.class)))
                .thenReturn(new AiChatResponse("Echo sẵn sàng hỗ trợ bạn ôn luyện IELTS!", "google/gemini-2.0-flash-001"));

        ResponseEntity<AiChatResponse> response = controller.chat(userDetails, request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().reply()).isEqualTo("Echo sẵn sàng hỗ trợ bạn ôn luyện IELTS!");
        assertThat(response.getBody().model()).isEqualTo("google/gemini-2.0-flash-001");
    }
}
