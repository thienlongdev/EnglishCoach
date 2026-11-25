package com.englishcoach.ai.service;

import com.englishcoach.ai.controller.EchoExceptionHandler;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.repository.*;
import com.englishcoach.echocoach.service.EchoCoachServiceImpl;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class EchoBoundaryTest {
    @Test void errorsNeverExposeRawDetails() {
        var response = new EchoExceptionHandler().handle(new RuntimeException("PRIVATE_CANARY jdbc:postgresql://private java.lang.Exception"));
        assertThat(response.getStatusCode().value()).isEqualTo(500);
        assertThat(response.getBody().toString()).doesNotContain("PRIVATE_CANARY", "jdbc:", "java.lang");
    }
    @Test void foreignSessionReadsWritesDeletesUseOwnerScopedLookup() {
        var sessions = mock(EchoCoachSessionRepository.class); var messages = mock(EchoCoachMessageRepository.class);
        var service = new EchoCoachServiceImpl(sessions, messages);
        assertThatThrownBy(() -> service.getSessionMessages(2L, 1L)).hasMessageContaining("404");
        assertThatThrownBy(() -> service.saveMessages(2L, 1L, new SaveMessagePairRequest("hello", "hi", null, null))).hasMessageContaining("404");
        assertThatThrownBy(() -> service.deleteSession(2L, 1L)).hasMessageContaining("404");
        verify(sessions, times(3)).findByIdAndUserId(1L, 2L); verifyNoInteractions(messages);
    }
    @Test void persistenceRejectsPrivilegedRolesAndOversize() {
        var sessions = mock(EchoCoachSessionRepository.class); var messages = mock(EchoCoachMessageRepository.class);
        var service = new EchoCoachServiceImpl(sessions, messages);
        assertThatThrownBy(() -> service.saveMessages(2L, 1L, new SaveMessagePairRequest(null, null, "system", "admin"))).hasMessageContaining("400");
        assertThatThrownBy(() -> service.saveMessages(2L, 1L, new SaveMessagePairRequest("x".repeat(4001), null, null, null))).hasMessageContaining("400");
        verifyNoInteractions(sessions, messages);
    }
}
