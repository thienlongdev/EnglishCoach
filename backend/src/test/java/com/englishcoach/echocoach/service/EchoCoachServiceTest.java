package com.englishcoach.echocoach.service;

import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachMessageDto;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.entity.EchoCoachMessage;
import com.englishcoach.echocoach.entity.EchoCoachSession;
import com.englishcoach.echocoach.repository.EchoCoachMessageRepository;
import com.englishcoach.echocoach.repository.EchoCoachSessionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class EchoCoachServiceTest {

    @Mock
    private EchoCoachSessionRepository sessionRepository;

    @Mock
    private EchoCoachMessageRepository messageRepository;

    @InjectMocks
    private EchoCoachServiceImpl echoCoachService;

    private final Long USER_A_ID = 100L;
    private final Long USER_B_ID = 200L;

    @BeforeEach
    void setUp() {
    }

    @Test
    @DisplayName("createSession: Successfully creates and persists a new session")
    void testCreateSessionAndPersist() {
        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(USER_A_ID))
                .thenReturn(new ArrayList<>());

        when(sessionRepository.save(any(EchoCoachSession.class))).thenAnswer(invocation -> {
            EchoCoachSession s = invocation.getArgument(0);
            s.setId(1L);
            return s;
        });

        CreateSessionRequest request = new CreateSessionRequest("Hướng dẫn về IELTS Writing Task 2");
        EchoCoachSessionDto result = echoCoachService.createSession(USER_A_ID, request);

        assertThat(result).isNotNull();
        assertThat(result.id()).isEqualTo(1L);
        assertThat(result.title()).isEqualTo("Hướng dẫn về IELTS Writing Task 2");

        ArgumentCaptor<EchoCoachSession> captor = ArgumentCaptor.forClass(EchoCoachSession.class);
        verify(sessionRepository).save(captor.capture());
        EchoCoachSession saved = captor.getValue();
        assertThat(saved.getUserId()).isEqualTo(USER_A_ID);
        assertThat(saved.getTitle()).isEqualTo("Hướng dẫn về IELTS Writing Task 2");
    }

    @Test
    @DisplayName("createSession: Automatically prunes oldest sessions when user has 15 or more active sessions")
    void testPruningOlderSessionsWhenExceeding15() {
        List<EchoCoachSession> existingSessions = new ArrayList<>();
        Instant baseTime = Instant.now();
        for (int i = 1; i <= 15; i++) {
            existingSessions.add(EchoCoachSession.builder()
                    .id((long) i)
                    .userId(USER_A_ID)
                    .title("Phiên " + i)
                    .createdAt(baseTime.minusSeconds(i * 100))
                    .updatedAt(baseTime.minusSeconds(i * 10))
                    .build());
        }

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(USER_A_ID))
                .thenReturn(existingSessions);

        when(sessionRepository.save(any(EchoCoachSession.class))).thenAnswer(invocation -> {
            EchoCoachSession s = invocation.getArgument(0);
            s.setId(16L);
            return s;
        });

        EchoCoachSessionDto result = echoCoachService.createSession(USER_A_ID, new CreateSessionRequest("Phiên mới"));

        assertThat(result).isNotNull();
        assertThat(result.id()).isEqualTo(16L);

        // Verify that the 15th session (index 14) was pruned
        ArgumentCaptor<List<Long>> idListCaptor = ArgumentCaptor.forClass(List.class);
        verify(messageRepository).deleteBySessionIdIn(idListCaptor.capture());
        assertThat(idListCaptor.getValue()).containsExactly(15L);

        ArgumentCaptor<List<EchoCoachSession>> sessionListCaptor = ArgumentCaptor.forClass(List.class);
        verify(sessionRepository).deleteAll(sessionListCaptor.capture());
        assertThat(sessionListCaptor.getValue()).hasSize(1);
        assertThat(sessionListCaptor.getValue().get(0).getId()).isEqualTo(15L);
    }

    @Test
    @DisplayName("getSessionMessages: Strict user isolation prevents User B from accessing User A's session")
    void testStrictUserIsolation() {
        Long sessionAId = 55L;

        // User B tries to access session 55 owned by User A
        when(sessionRepository.findByIdAndUserId(sessionAId, USER_B_ID))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() -> echoCoachService.getSessionMessages(USER_B_ID, sessionAId))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
                });

        verify(messageRepository, never()).findBySessionIdOrderByCreatedAtAsc(any());
    }

    @Test
    @DisplayName("saveMessages: Persists user & assistant message pair and auto-updates default session title")
    void testSaveMessagePairAndAutoTitle() {
        Long sessionId = 10L;
        EchoCoachSession session = EchoCoachSession.builder()
                .id(sessionId)
                .userId(USER_A_ID)
                .title("Cuộc trò chuyện mới")
                .createdAt(Instant.now().minusSeconds(60))
                .updatedAt(Instant.now().minusSeconds(60))
                .build();

        when(sessionRepository.findByIdAndUserId(sessionId, USER_A_ID))
                .thenReturn(Optional.of(session));

        when(messageRepository.save(any(EchoCoachMessage.class))).thenAnswer(invocation -> {
            EchoCoachMessage m = invocation.getArgument(0);
            m.setId(100L);
            return m;
        });

        SaveMessagePairRequest request = new SaveMessagePairRequest(
                "Làm sao để cải thiện phát âm âm /θ/ trong tiếng Anh?",
                "Bạn nên đặt đầu lưỡi giữa hai hàm răng và đẩy luồng hơi nhẹ nhàng.",
                null,
                null
        );

        List<EchoCoachMessageDto> saved = echoCoachService.saveMessages(USER_A_ID, sessionId, request);

        assertThat(saved).hasSize(2);
        assertThat(saved.get(0).role()).isEqualTo("user");
        assertThat(saved.get(0).content()).isEqualTo("Làm sao để cải thiện phát âm âm /θ/ trong tiếng Anh?");
        assertThat(saved.get(1).role()).isEqualTo("assistant");
        assertThat(saved.get(1).content()).isEqualTo("Bạn nên đặt đầu lưỡi giữa hai hàm răng và đẩy luồng hơi nhẹ nhàng.");

        // Title should be updated from default to user query summary
        verify(sessionRepository).save(session);
        assertThat(session.getTitle()).isEqualTo("Làm sao để cải thiện phát âm âm /θ/ trong tiếng Anh?");
    }

    @Test
    @DisplayName("deleteSession: User can delete their own session, but 404s on another user's session")
    void testDeleteSession() {
        Long sessionId = 10L;
        EchoCoachSession session = EchoCoachSession.builder()
                .id(sessionId)
                .userId(USER_A_ID)
                .title("Session to delete")
                .build();

        when(sessionRepository.findByIdAndUserId(sessionId, USER_A_ID))
                .thenReturn(Optional.of(session));

        echoCoachService.deleteSession(USER_A_ID, sessionId);

        verify(messageRepository).deleteBySessionId(sessionId);
        verify(sessionRepository).delete(session);

        // User B cannot delete User A's session
        when(sessionRepository.findByIdAndUserId(sessionId, USER_B_ID))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() -> echoCoachService.deleteSession(USER_B_ID, sessionId))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }
}
