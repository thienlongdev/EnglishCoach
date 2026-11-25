package com.englishcoach.echocoach.service;

import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachMessageDto;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.entity.EchoCoachMessage;
import com.englishcoach.echocoach.entity.EchoCoachSession;
import com.englishcoach.echocoach.repository.EchoCoachMessageRepository;
import com.englishcoach.echocoach.repository.EchoCoachSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Service
@RequiredArgsConstructor
@Slf4j
public class EchoCoachServiceImpl implements EchoCoachService {

    public static final int MAX_SESSIONS_PER_USER = 15;
    private static final String DEFAULT_SESSION_TITLE = "Cuộc trò chuyện mới";

    private final EchoCoachSessionRepository sessionRepository;
    private final EchoCoachMessageRepository messageRepository;

    @Override
    @Transactional(readOnly = true)
    public List<EchoCoachSessionDto> getRecentSessions(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }
        List<EchoCoachSession> sessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        return sessions.stream()
                .limit(MAX_SESSIONS_PER_USER)
                .map(this::toSessionDto)
                .toList();
    }

    @Override
    @Transactional
    public EchoCoachSessionDto createSession(Long userId, CreateSessionRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }

        // 1. Prune older sessions exceeding the 15-session cap
        pruneOldSessionsExceedingLimit(userId, MAX_SESSIONS_PER_USER - 1);

        // 2. Prepare title
        String title = DEFAULT_SESSION_TITLE;
        if (request != null && request.title() != null && !request.title().trim().isEmpty()) {
            title = request.title().trim();
            if (title.length() > 255) {
                title = title.substring(0, 252) + "...";
            }
        }

        Instant now = Instant.now();
        EchoCoachSession session = EchoCoachSession.builder()
                .userId(userId)
                .title(title)
                .createdAt(now)
                .updatedAt(now)
                .build();

        EchoCoachSession saved = sessionRepository.save(session);
        log.info("[Echo Coach] Created new chat session id={} for userId={}", saved.getId(), userId);
        return toSessionDto(saved);
    }

    @Override
    @Transactional(readOnly = true)
    public List<EchoCoachMessageDto> getSessionMessages(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }
        // Strict user ownership check (Section 21 AGENTS.md)
        EchoCoachSession session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy phiên trò chuyện"));

        List<EchoCoachMessage> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId());
        return messages.stream()
                .map(this::toMessageDto)
                .toList();
    }

    @Override
    @Transactional
    public List<EchoCoachMessageDto> saveMessages(Long userId, Long sessionId, SaveMessagePairRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Request body is required");
        }
        if ((request.userMessage() != null && request.userMessage().length() > 4000)
                || (request.assistantMessage() != null && request.assistantMessage().length() > 12000)
                || (request.content() != null && request.content().length() > 12000)
                || (request.role() != null && !List.of("user", "assistant").contains(request.role()))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid conversation message");
        }

        // Strict user ownership check
        EchoCoachSession session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy phiên trò chuyện"));

        List<EchoCoachMessage> savedMessages = new ArrayList<>();
        Instant now = Instant.now();

        // 1. Check if userMessage / assistantMessage pair
        if (request.userMessage() != null && !request.userMessage().trim().isEmpty()) {
            EchoCoachMessage userMsg = EchoCoachMessage.builder()
                    .sessionId(session.getId())
                    .role("user")
                    .content(request.userMessage().trim())
                    .createdAt(now)
                    .build();
            savedMessages.add(messageRepository.save(userMsg));

            // Auto-update session title if default
            if (DEFAULT_SESSION_TITLE.equalsIgnoreCase(session.getTitle()) || session.getTitle().isBlank()) {
                String derived = summarizeTitle(request.userMessage());
                session.setTitle(derived);
            }
        }

        if (request.assistantMessage() != null && !request.assistantMessage().trim().isEmpty()) {
            EchoCoachMessage assistantMsg = EchoCoachMessage.builder()
                    .sessionId(session.getId())
                    .role("assistant")
                    .content(request.assistantMessage().trim())
                    .createdAt(now.plusMillis(1))
                    .build();
            savedMessages.add(messageRepository.save(assistantMsg));
        }

        // 2. Fallback single message mode if provided
        if (savedMessages.isEmpty() && request.content() != null && !request.content().trim().isEmpty()) {
            String role = (request.role() != null && !request.role().trim().isEmpty())
                    ? request.role().trim().toLowerCase()
                    : "user";
            EchoCoachMessage singleMsg = EchoCoachMessage.builder()
                    .sessionId(session.getId())
                    .role(role)
                    .content(request.content().trim())
                    .createdAt(now)
                    .build();
            savedMessages.add(messageRepository.save(singleMsg));

            if ("user".equals(role) && (DEFAULT_SESSION_TITLE.equalsIgnoreCase(session.getTitle()) || session.getTitle().isBlank())) {
                session.setTitle(summarizeTitle(request.content()));
            }
        }

        session.setUpdatedAt(now);
        sessionRepository.save(session);

        log.debug("[Echo Coach] Persisted {} message(s) for sessionId={}", savedMessages.size(), sessionId);
        return savedMessages.stream().map(this::toMessageDto).toList();
    }

    @Override
    @Transactional
    public void deleteSession(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }
        EchoCoachSession session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy phiên trò chuyện"));

        messageRepository.deleteBySessionId(session.getId());
        sessionRepository.delete(session);
        log.info("[Echo Coach] Deleted sessionId={} for userId={}", sessionId, userId);
    }

    @Override
    @Transactional
    public boolean truncateLatestAssistantMessage(Long userId, Long sessionId, String spokenText) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not authenticated");
        }
        if (sessionId == null || sessionId <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid sessionId");
        }
        if (spokenText != null && spokenText.length() > 12000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid spokenText length");
        }
        // Strict ownership check before touching messages
        EchoCoachSession session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy phiên trò chuyện"));
        if (spokenText == null || spokenText.isBlank()) {
            return false;
        }
        String cleanSpoken = spokenText.trim();
        List<EchoCoachMessage> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId());
        for (int i = messages.size() - 1; i >= 0; i--) {
            EchoCoachMessage m = messages.get(i);
            if ("assistant".equalsIgnoreCase(m.getRole())) {
                String existing = m.getContent() == null ? "" : m.getContent().trim();
                if (!cleanSpoken.isEmpty() && cleanSpoken.length() < existing.length()) {
                    m.setContent(cleanSpoken);
                    messageRepository.save(m);
                    session.setUpdatedAt(Instant.now());
                    sessionRepository.save(session);
                    return true;
                }
                return false;
            }
        }
        return false;
    }

    private void pruneOldSessionsExceedingLimit(Long userId, int targetRemaining) {
        List<EchoCoachSession> existing = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        if (existing.size() > targetRemaining) {
            List<EchoCoachSession> toDelete = existing.subList(targetRemaining, existing.size());
            List<Long> idsToDelete = toDelete.stream().map(EchoCoachSession::getId).toList();
            if (!idsToDelete.isEmpty()) {
                messageRepository.deleteBySessionIdIn(idsToDelete);
                sessionRepository.deleteAll(toDelete);
                log.info("[Echo Coach] Pruned {} old sessions for userId={} exceeding cap of {}",
                        toDelete.size(), userId, MAX_SESSIONS_PER_USER);
            }
        }
    }

    private String summarizeTitle(String text) {
        if (text == null) return DEFAULT_SESSION_TITLE;
        String clean = text.replaceAll("\\s+", " ").trim();
        if (clean.length() <= 80) {
            return clean;
        }
        return clean.substring(0, 77) + "...";
    }

    private EchoCoachSessionDto toSessionDto(EchoCoachSession s) {
        return new EchoCoachSessionDto(
                s.getId(),
                s.getTitle(),
                s.getCreatedAt(),
                s.getUpdatedAt()
        );
    }

    private EchoCoachMessageDto toMessageDto(EchoCoachMessage m) {
        return new EchoCoachMessageDto(
                m.getId(),
                m.getSessionId(),
                m.getRole(),
                m.getContent(),
                m.getCreatedAt()
        );
    }
}
