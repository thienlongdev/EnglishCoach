package com.englishcoach.ai;

import com.englishcoach.ai.dto.AiChatMessageDto;
import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.service.OpenRouterChatServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.when;

class OpenRouterChatServiceTest {

    private RestTemplate restTemplate;
    private OpenRouterChatServiceImpl chatService;

    @BeforeEach
    void setUp() {
        restTemplate = Mockito.mock(RestTemplate.class);
        chatService = new OpenRouterChatServiceImpl(
                restTemplate,
                "sk-or-v1-test-key",
                "https://openrouter.ai/api/v1",
                "google/gemini-2.0-flash-001"
        );
    }

    @Test
    @DisplayName("Normal Echo Chat: successfully sends message and extracts reply from OpenRouter response")
    void chat_successfulCompletion_returnsReplyAndModel() {
        Map<String, Object> choiceMsg = Map.of("role", "assistant", "content", "Hello! I am Echo. Here is your IELTS plan.");
        Map<String, Object> choice = Map.of("message", choiceMsg);
        Map<String, Object> responseBody = Map.of(
                "model", "google/gemini-2.0-flash-001",
                "choices", List.of(choice)
        );

        when(restTemplate.postForEntity(eq("https://openrouter.ai/api/v1/chat/completions"), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        AiChatRequest request = new AiChatRequest(List.of(
                new AiChatMessageDto("user", "Give me a simple IELTS Speaking plan.")
        ));

        AiChatResponse response = chatService.chat(1L, request);

        assertThat(response).isNotNull();
        assertThat(response.reply()).isEqualTo("Hello! I am Echo. Here is your IELTS plan.");
        assertThat(response.model()).isEqualTo("google/gemini-2.0-flash-001");
    }

    @Test
    @DisplayName("Multi-turn Chat: retains conversation context and prepends Echo system prompt")
    @SuppressWarnings("unchecked")
    void chat_multiTurnContext_includesRecentHistoryAndSystemPrompt() {
        Map<String, Object> choiceMsg = Map.of("role", "assistant", "content", "To improve speaking, focus on shadowing.");
        Map<String, Object> choice = Map.of("message", choiceMsg);
        Map<String, Object> responseBody = Map.of(
                "model", "google/gemini-2.0-flash-001",
                "choices", List.of(choice)
        );

        ArgumentCaptor<HttpEntity<Map<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        when(restTemplate.postForEntity(eq("https://openrouter.ai/api/v1/chat/completions"), captor.capture(), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        AiChatRequest request = new AiChatRequest(List.of(
                new AiChatMessageDto("assistant", "Tôi là Echo 👋 Bạn muốn học gì hôm nay?"),
                new AiChatMessageDto("user", "pass ielts"),
                new AiChatMessageDto("assistant", "IELTS requires balanced practice across 4 skills."),
                new AiChatMessageDto("user", "how can I improve speaking?")
        ));

        AiChatResponse response = chatService.chat(1L, request);

        assertThat(response.reply()).isEqualTo("To improve speaking, focus on shadowing.");

        Map<String, Object> requestBody = captor.getValue().getBody();
        assertThat(requestBody).isNotNull();
        List<Map<String, String>> messages = (List<Map<String, String>>) requestBody.get("messages");

        // First message must be Echo system prompt
        assertThat(messages.get(0).get("role")).isEqualTo("system");
        assertThat(messages.get(0).get("content")).contains("You are Echo, the whale mascot and AI learning coach inside English Coach");

        // Conversation messages follow
        assertThat(messages.get(1).get("role")).isEqualTo("assistant");
        assertThat(messages.get(2).get("role")).isEqualTo("user");
        assertThat(messages.get(2).get("content")).isEqualTo("pass ielts");
        assertThat(messages.get(4).get("content")).isEqualTo("how can I improve speaking?");
    }

    @Test
    @DisplayName("Empty Input: empty messages throws 400 Bad Request")
    void chat_emptyMessages_throwsBadRequest() {
        AiChatRequest emptyRequest = new AiChatRequest(Collections.emptyList());

        assertThatThrownBy(() -> chatService.chat(1L, emptyRequest))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Messages list must not be empty");
    }

    @Test
    @DisplayName("Provider Failure: handles HTTP 502 / error without leaking API secret")
    void chat_providerError_throwsSanitizedException() {
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenThrow(new HttpClientErrorException(HttpStatus.UNAUTHORIZED, "Unauthorized"));

        AiChatRequest request = new AiChatRequest(List.of(
                new AiChatMessageDto("user", "Hello")
        ));

        assertThatThrownBy(() -> chatService.chat(1L, request))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
                    // Crucial: Secret must never be in exception message
                    assertThat(rse.getMessage()).doesNotContain("sk-or-v1-test-key");
                });
    }

    @Test
    @DisplayName("Network Failure: handles connection timeout without leaking sensitive data")
    void chat_connectionTimeout_throwsServiceUnavailable() {
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenThrow(new RestClientException("Connection timed out"));

        AiChatRequest request = new AiChatRequest(List.of(
                new AiChatMessageDto("user", "Hello")
        ));

        assertThatThrownBy(() -> chatService.chat(1L, request))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(rse.getMessage()).doesNotContain("sk-or-v1-test-key");
                });
    }
}
