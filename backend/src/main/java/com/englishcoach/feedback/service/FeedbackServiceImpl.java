package com.englishcoach.feedback.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.feedback.dto.*;
import com.englishcoach.feedback.entity.FeedbackMessage;
import com.englishcoach.feedback.entity.FeedbackThread;
import com.englishcoach.feedback.repository.FeedbackMessageRepository;
import com.englishcoach.feedback.repository.FeedbackThreadRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

import org.springframework.context.annotation.Lazy;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

@Service
@Slf4j
public class FeedbackServiceImpl implements FeedbackService {

    private final FeedbackThreadRepository feedbackThreadRepository;
    private final FeedbackMessageRepository feedbackMessageRepository;
    private final UserRepository userRepository;
    private final SimpMessagingTemplate messagingTemplate;

    public FeedbackServiceImpl(
            FeedbackThreadRepository feedbackThreadRepository,
            FeedbackMessageRepository feedbackMessageRepository,
            UserRepository userRepository,
            @Lazy SimpMessagingTemplate messagingTemplate
    ) {
        this.feedbackThreadRepository = feedbackThreadRepository;
        this.feedbackMessageRepository = feedbackMessageRepository;
        this.userRepository = userRepository;
        this.messagingTemplate = messagingTemplate;
    }

    private void runAfterCommitOrNow(Runnable task) {
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    task.run();
                }
            });
        } else {
            task.run();
        }
    }

    private FeedbackUnreadCountDto countAdminUnreadInternal() {
        long count = feedbackThreadRepository.countByAdminUnreadTrue();
        return new FeedbackUnreadCountDto(count);
    }

    private FeedbackUnreadCountDto countUserUnreadInternal(Long userId) {
        long count = feedbackThreadRepository.countByUserIdAndUserUnreadTrue(userId);
        return new FeedbackUnreadCountDto(count);
    }

    private void broadcastAdminBadge() {
        if (messagingTemplate == null) return;
        final FeedbackUnreadCountDto count;
        try {
            count = countAdminUnreadInternal();
        } catch (Exception e) {
            log.warn("[Feedback] Failed to compute admin feedback badge: {}", e.getMessage());
            return;
        }
        runAfterCommitOrNow(() -> {
            try {
                messagingTemplate.convertAndSend("/topic/admin/feedback-badge", count);
            } catch (Exception e) {
                log.warn("[Feedback] Failed to broadcast admin feedback badge: {}", e.getMessage());
            }
        });
    }

    private void broadcastUserBadge(Long userId) {
        if (userId == null || messagingTemplate == null) return;
        final FeedbackUnreadCountDto count;
        try {
            count = countUserUnreadInternal(userId);
        } catch (Exception e) {
            log.warn("[Feedback] Failed to compute user feedback badge to userId={}: {}", userId, e.getMessage());
            return;
        }
        runAfterCommitOrNow(() -> {
            try {
                messagingTemplate.convertAndSend("/topic/user/" + userId + "/feedback-badge", count);
            } catch (Exception e) {
                log.warn("[Feedback] Failed to broadcast user feedback badge to userId={}: {}", userId, e.getMessage());
            }
        });
    }

    private void broadcastThreadMessage(Long threadId, FeedbackMessageDto message) {
        if (threadId == null || message == null || messagingTemplate == null) return;
        runAfterCommitOrNow(() -> {
            try {
                messagingTemplate.convertAndSend("/topic/feedback/" + threadId, message);
            } catch (Exception e) {
                log.warn("[Feedback] Failed to broadcast message to thread id={}: {}", threadId, e.getMessage());
            }
        });
    }

    private static final Set<String> VALID_CATEGORIES = Set.of("IDEA", "BUG", "UI", "CONTENT", "OTHER");

    private void enforceRateLimit(Long userId) {
        Instant oneHourAgo = Instant.now().minus(1, ChronoUnit.HOURS);
        long recentCount = feedbackMessageRepository.countBySenderUserIdAndCreatedAtAfter(userId, oneHourAgo);
        if (recentCount >= 5) {
            log.warn("[Feedback] User id={} exceeded rate limit (recentCount={})", userId, recentCount);
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Giới hạn 5 góp ý mỗi giờ. Vui lòng thử lại sau.");
        }
    }

    private String normalizeCategory(String category) {
        if (category == null || category.isBlank()) {
            return "OTHER";
        }
        String upper = category.trim().toUpperCase(Locale.ROOT);
        return VALID_CATEGORIES.contains(upper) ? upper : "OTHER";
    }

    @Override
    @Transactional
    public FeedbackThreadDto createThread(Long userId, CreateFeedbackRequest request) {
        enforceRateLimit(userId);

        String category = normalizeCategory(request.category());
        Instant now = Instant.now();

        FeedbackThread thread = FeedbackThread.builder()
                .userId(userId)
                .category(category)
                .subject(request.subject().trim())
                .status("OPEN")
                .adminUnread(true)
                .userUnread(false)
                .lastMessageAt(now)
                .build();

        FeedbackThread savedThread = feedbackThreadRepository.save(thread);

        FeedbackMessage message = FeedbackMessage.builder()
                .threadId(savedThread.getId())
                .senderUserId(userId)
                .fromAdmin(false)
                .content(request.content().trim())
                .build();

        feedbackMessageRepository.save(message);

        log.info("[Feedback] User id={} created thread id={} with category={}", userId, savedThread.getId(), category);

        broadcastAdminBadge();

        User user = userRepository.findById(userId).orElse(null);
        String userName = user != null ? user.getName() : "Học viên";
        String userEmail = user != null ? user.getEmail() : "";

        return new FeedbackThreadDto(
                savedThread.getId(),
                savedThread.getUserId(),
                userName,
                userEmail,
                savedThread.getCategory(),
                savedThread.getSubject(),
                savedThread.getStatus(),
                savedThread.isAdminUnread(),
                savedThread.isUserUnread(),
                savedThread.getCreatedAt(),
                savedThread.getLastMessageAt(),
                request.content().trim()
        );
    }

    private Map<Long, String> loadLatestSnippets(List<FeedbackThread> threads) {
        if (threads == null || threads.isEmpty()) {
            return Collections.emptyMap();
        }
        List<Long> threadIds = threads.stream()
                .map(FeedbackThread::getId)
                .filter(Objects::nonNull)
                .distinct()
                .toList();
        if (threadIds.isEmpty()) {
            return Collections.emptyMap();
        }
        List<FeedbackMessageRepository.LatestSnippetProjection> rows =
                feedbackMessageRepository.findLatestSnippetsByThreadIds(threadIds);
        if (rows == null || rows.isEmpty()) {
            return Collections.emptyMap();
        }
        Map<Long, String> snippets = new HashMap<>(rows.size());
        for (FeedbackMessageRepository.LatestSnippetProjection row : rows) {
            if (row != null && row.getThreadId() != null) {
                snippets.put(row.getThreadId(), row.getContent() != null ? row.getContent() : "");
            }
        }
        return snippets;
    }

    @Override
    @Transactional(readOnly = true)
    public List<FeedbackThreadDto> getMyThreads(Long userId) {
        List<FeedbackThread> threads = feedbackThreadRepository.findByUserIdOrderByLastMessageAtDesc(userId);
        if (threads.isEmpty()) {
            return Collections.emptyList();
        }

        User user = userRepository.findById(userId).orElse(null);
        String userName = user != null ? user.getName() : "Học viên";
        String userEmail = user != null ? user.getEmail() : "";
        Map<Long, String> latestSnippets = loadLatestSnippets(threads);

        return threads.stream().map(t -> {
            String snippet = latestSnippets.getOrDefault(t.getId(), "");
            return new FeedbackThreadDto(
                    t.getId(),
                    t.getUserId(),
                    userName,
                    userEmail,
                    t.getCategory(),
                    t.getSubject(),
                    t.getStatus(),
                    t.isAdminUnread(),
                    t.isUserUnread(),
                    t.getCreatedAt(),
                    t.getLastMessageAt(),
                    snippet
            );
        }).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public FeedbackUnreadCountDto getMyUnreadCount(Long userId) {
        return countUserUnreadInternal(userId);
    }

    @Override
    @Transactional
    public FeedbackMessageDto userFollowUp(Long userId, Long threadId, FeedbackMessageRequest request) {
        enforceRateLimit(userId);

        FeedbackThread thread = feedbackThreadRepository.findById(threadId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy góp ý"));

        if (!thread.getUserId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Bạn không có quyền phản hồi góp ý này");
        }

        Instant now = Instant.now();
        FeedbackMessage message = FeedbackMessage.builder()
                .threadId(threadId)
                .senderUserId(userId)
                .fromAdmin(false)
                .content(request.content().trim())
                .build();

        FeedbackMessage savedMessage = feedbackMessageRepository.save(message);

        thread.setStatus("OPEN");
        thread.setAdminUnread(true);
        thread.setLastMessageAt(now);
        feedbackThreadRepository.save(thread);

        User user = userRepository.findById(userId).orElse(null);
        String senderName = user != null ? user.getName() : "Học viên";

        FeedbackMessageDto messageDto = new FeedbackMessageDto(
                savedMessage.getId(),
                savedMessage.getThreadId(),
                savedMessage.getSenderUserId(),
                senderName,
                false,
                savedMessage.getContent(),
                savedMessage.getCreatedAt()
        );

        broadcastThreadMessage(threadId, messageDto);
        broadcastAdminBadge();

        return messageDto;
    }

    @Override
    @Transactional(readOnly = true)
    public List<FeedbackThreadDto> getAdminInbox() {
        List<FeedbackThread> threads = feedbackThreadRepository.findAllByOrderByLastMessageAtDesc();
        if (threads.isEmpty()) {
            return Collections.emptyList();
        }

        Set<Long> userIds = threads.stream().map(FeedbackThread::getUserId).collect(Collectors.toSet());
        Map<Long, User> userMap = userRepository.findAllById(userIds).stream()
                .collect(Collectors.toMap(User::getId, u -> u));
        Map<Long, String> latestSnippets = loadLatestSnippets(threads);

        return threads.stream().map(t -> {
            User u = userMap.get(t.getUserId());
            String userName = u != null ? u.getName() : "Học viên #" + t.getUserId();
            String userEmail = u != null ? u.getEmail() : "";
            String snippet = latestSnippets.getOrDefault(t.getId(), "");

            return new FeedbackThreadDto(
                    t.getId(),
                    t.getUserId(),
                    userName,
                    userEmail,
                    t.getCategory(),
                    t.getSubject(),
                    t.getStatus(),
                    t.isAdminUnread(),
                    t.isUserUnread(),
                    t.getCreatedAt(),
                    t.getLastMessageAt(),
                    snippet
            );
        }).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public FeedbackUnreadCountDto getAdminUnreadCount() {
        return countAdminUnreadInternal();
    }

    @Override
    @Transactional
    public FeedbackMessageDto adminReply(Long adminUserId, Long threadId, FeedbackMessageRequest request) {
        FeedbackThread thread = feedbackThreadRepository.findById(threadId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy góp ý"));

        Instant now = Instant.now();
        FeedbackMessage message = FeedbackMessage.builder()
                .threadId(threadId)
                .senderUserId(adminUserId)
                .fromAdmin(true)
                .content(request.content().trim())
                .build();

        FeedbackMessage savedMessage = feedbackMessageRepository.save(message);

        thread.setStatus("ANSWERED");
        thread.setUserUnread(true);
        thread.setAdminUnread(false);
        thread.setLastMessageAt(now);
        feedbackThreadRepository.save(thread);

        log.info("[Feedback] Admin id={} replied to thread id={}", adminUserId, threadId);

        User adminUser = userRepository.findById(adminUserId).orElse(null);
        String senderName = adminUser != null ? adminUser.getName() : "Admin EnglishCoach";

        FeedbackMessageDto replyDto = new FeedbackMessageDto(
                savedMessage.getId(),
                savedMessage.getThreadId(),
                savedMessage.getSenderUserId(),
                senderName,
                true,
                savedMessage.getContent(),
                savedMessage.getCreatedAt()
        );

        broadcastThreadMessage(threadId, replyDto);
        broadcastUserBadge(thread.getUserId());
        broadcastAdminBadge();

        return replyDto;
    }

    @Override
    @Transactional
    public FeedbackThreadDto closeThread(Long threadId) {
        FeedbackThread thread = feedbackThreadRepository.findById(threadId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy góp ý"));

        thread.setStatus("CLOSED");
        FeedbackThread saved = feedbackThreadRepository.save(thread);

        broadcastUserBadge(saved.getUserId());
        if (messagingTemplate != null) {
            runAfterCommitOrNow(() -> {
                try {
                    messagingTemplate.convertAndSend("/topic/feedback/" + threadId, Map.of(
                            "type", "STATUS_CHANGE",
                            "status", "CLOSED",
                            "threadId", threadId
                    ));
                } catch (Exception e) {
                    log.warn("[Feedback] Failed to broadcast thread closure: {}", e.getMessage());
                }
            });
        }

        User user = userRepository.findById(saved.getUserId()).orElse(null);
        String userName = user != null ? user.getName() : "Học viên #" + saved.getUserId();
        String userEmail = user != null ? user.getEmail() : "";

        return new FeedbackThreadDto(
                saved.getId(),
                saved.getUserId(),
                userName,
                userEmail,
                saved.getCategory(),
                saved.getSubject(),
                saved.getStatus(),
                saved.isAdminUnread(),
                saved.isUserUnread(),
                saved.getCreatedAt(),
                saved.getLastMessageAt(),
                ""
        );
    }

    @Override
    @Transactional
    public List<FeedbackMessageDto> getThreadMessages(Long userId, boolean isAdmin, Long threadId) {
        FeedbackThread thread = feedbackThreadRepository.findById(threadId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy góp ý"));

        if (isAdmin) {
            if (thread.isAdminUnread()) {
                thread.setAdminUnread(false);
                feedbackThreadRepository.save(thread);
                broadcastAdminBadge();
            }
        } else {
            if (!thread.getUserId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Bạn không có quyền xem góp ý này");
            }
            if (thread.isUserUnread()) {
                thread.setUserUnread(false);
                feedbackThreadRepository.save(thread);
                broadcastUserBadge(userId);
            }
        }

        List<FeedbackMessage> messages = feedbackMessageRepository.findByThreadIdOrderByCreatedAtAsc(threadId);
        if (messages.isEmpty()) {
            return Collections.emptyList();
        }

        Set<Long> senderIds = messages.stream().map(FeedbackMessage::getSenderUserId).collect(Collectors.toSet());
        Map<Long, User> userMap = userRepository.findAllById(senderIds).stream()
                .collect(Collectors.toMap(User::getId, u -> u));

        return messages.stream().map(m -> {
            String senderName;
            if (m.isFromAdmin()) {
                senderName = "Admin EnglishCoach";
            } else {
                User u = userMap.get(m.getSenderUserId());
                senderName = u != null ? u.getName() : "Học viên";
            }

            return new FeedbackMessageDto(
                    m.getId(),
                    m.getThreadId(),
                    m.getSenderUserId(),
                    senderName,
                    m.isFromAdmin(),
                    m.getContent(),
                    m.getCreatedAt()
            );
        }).toList();
    }
}
