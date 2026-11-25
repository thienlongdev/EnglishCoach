package com.englishcoach.notification.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.notification.dto.*;
import com.englishcoach.notification.entity.Notification;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationScope;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.repository.LearnerNotificationProjection;
import com.englishcoach.notification.repository.NotificationRepository;
import com.englishcoach.notification.repository.NotificationUserStateRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Collectors;

@Service
@Slf4j
public class NotificationServiceImpl implements NotificationService {

    private static final String GLOBAL_CACHE_KEY = "global-notifications";
    private static final long GLOBAL_CACHE_TTL_MS = Duration.ofSeconds(60).toMillis();

    /** Immutable snapshot of raw GLOBAL notification metadata (NEVER stores USER scope or per-user read/dismiss states). */
    private record GlobalNotificationSnapshot(
            Long id,
            String type,
            String title,
            String body,
            String actionUrl,
            Instant publishAt,
            Instant expiresAt
    ) {}

    private final BoundedTtlCache<String, List<GlobalNotificationSnapshot>> globalNotificationsCache =
            new BoundedTtlCache<>(1, GLOBAL_CACHE_TTL_MS);

    private final NotificationRepository notificationRepository;
    private final NotificationUserStateRepository notificationUserStateRepository;
    private final UserRepository userRepository;
    private final SimpMessagingTemplate messagingTemplate;
    private final NotificationPushPublisher pushPublisher;

    @Value("${app.notifications.realtime.enabled:true}")
    private boolean realtimeEnabled = true;

    @Autowired
    public NotificationServiceImpl(
            NotificationRepository notificationRepository,
            NotificationUserStateRepository notificationUserStateRepository,
            UserRepository userRepository,
            @Lazy SimpMessagingTemplate messagingTemplate,
            @Lazy NotificationPushPublisher pushPublisher
    ) {
        this.notificationRepository = notificationRepository;
        this.notificationUserStateRepository = notificationUserStateRepository;
        this.userRepository = userRepository;
        this.messagingTemplate = messagingTemplate;
        this.pushPublisher = pushPublisher;
    }

    public NotificationServiceImpl(
            NotificationRepository notificationRepository,
            NotificationUserStateRepository notificationUserStateRepository,
            UserRepository userRepository,
            @Lazy SimpMessagingTemplate messagingTemplate
    ) {
        this(notificationRepository, notificationUserStateRepository, userRepository, messagingTemplate, null);
    }

    @Override
    @Transactional(readOnly = true)
    public List<LearnerNotificationDto> getLearnerNotifications(Long userId, Integer limit) {
        int boundedLimit = (limit != null && limit > 0) ? Math.min(limit, 50) : 20;
        Instant now = Instant.now();

        // 1. Raw GLOBAL notification metadata from 60s shared cache, filtered LIVE by publishAt/expiresAt
        List<GlobalNotificationSnapshot> activeGlobal = loadRawGlobalNotifications(now).stream()
                .filter(g -> g.publishAt() != null && !g.publishAt().isAfter(now))
                .filter(g -> g.expiresAt() == null || g.expiresAt().isAfter(now))
                .toList();

        // 2. Live per-user states overlaid ONLY for currently active GLOBAL notifications (never cached)
        List<LearnerNotificationDto> merged = new ArrayList<>(boundedLimit + activeGlobal.size());
        if (!activeGlobal.isEmpty()) {
            List<Long> globalIds = activeGlobal.stream().map(GlobalNotificationSnapshot::id).toList();
            Map<Long, NotificationRepository.GlobalNotificationStateProjection> stateByNotifId = new HashMap<>();
            List<NotificationRepository.GlobalNotificationStateProjection> states =
                    notificationRepository.findUserStatesForNotifications(userId, globalIds);
            if (states != null) {
                for (NotificationRepository.GlobalNotificationStateProjection st : states) {
                    if (st != null && st.getNotificationId() != null) {
                        stateByNotifId.put(st.getNotificationId(), st);
                    }
                }
            }
            for (GlobalNotificationSnapshot g : activeGlobal) {
                NotificationRepository.GlobalNotificationStateProjection st = stateByNotifId.get(g.id());
                if (st != null && Boolean.TRUE.equals(st.getIsDismissed())) {
                    continue;
                }
                merged.add(new LearnerNotificationDto(
                        g.id(),
                        g.type(),
                        g.title(),
                        g.body(),
                        g.actionUrl(),
                        g.publishAt(),
                        st != null && Boolean.TRUE.equals(st.getIsRead())
                ));
            }
        }

        // 3. Live USER-scoped notifications (never cached)
        List<LearnerNotificationProjection> userProjections =
                notificationRepository.findVisibleUserScopedNotifications(userId, now, boundedLimit);
        if (userProjections != null) {
            for (LearnerNotificationProjection p : userProjections) {
                merged.add(new LearnerNotificationDto(
                        p.getId(),
                        p.getType(),
                        p.getTitle(),
                        p.getBody(),
                        p.getActionUrl(),
                        p.getPublishAt(),
                        Boolean.TRUE.equals(p.getIsRead())
                ));
            }
        }

        // 4. Deterministic merge order: publishAt DESC, id DESC, capped to boundedLimit
        merged.sort(Comparator.comparing(LearnerNotificationDto::publishedAt, Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(LearnerNotificationDto::id, Comparator.nullsLast(Comparator.reverseOrder())));
        if (merged.size() > boundedLimit) {
            return List.copyOf(merged.subList(0, boundedLimit));
        }
        return List.copyOf(merged);
    }

    private List<GlobalNotificationSnapshot> loadRawGlobalNotifications(Instant now) {
        List<GlobalNotificationSnapshot> cached = globalNotificationsCache.get(GLOBAL_CACHE_KEY, ignored -> {
            List<Notification> rows = notificationRepository.findAllNonExpiredGlobalNotifications(now);
            if (rows == null || rows.isEmpty()) {
                return List.of();
            }
            return rows.stream()
                    .filter(n -> n != null && n.getScope() == NotificationScope.GLOBAL)
                    .map(n -> new GlobalNotificationSnapshot(
                            n.getId(),
                            n.getType() != null ? n.getType().name() : null,
                            n.getTitle(),
                            n.getBody(),
                            n.getActionUrl(),
                            n.getPublishAt(),
                            n.getExpiresAt()
                    ))
                    .toList();
        });
        return cached != null ? cached : List.of();
    }

    public void evictGlobalNotificationsCache() {
        globalNotificationsCache.clear();
    }

    private void evictGlobalNotificationsCacheAfterCommit() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    globalNotificationsCache.clear();
                }
            });
        } else {
            globalNotificationsCache.clear();
        }
    }

    @Override
    @Transactional(readOnly = true)
    public UnreadCountDto getUnreadCount(Long userId) {
        Instant now = Instant.now();
        long unreadCount = notificationRepository.countUnreadForUser(userId, now);
        return new UnreadCountDto(unreadCount);
    }

    @Override
    @Transactional
    public void markAsRead(Long userId, Long notificationId) {
        Instant now = Instant.now();
        boolean isAccessible = notificationRepository.isNotificationAccessibleToUser(notificationId, userId, now);
        if (!isAccessible) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Notification not found or not accessible");
        }
        notificationUserStateRepository.markAsRead(notificationId, userId, now);
        notificationRepository.markNotificationAsRead(notificationId, userId, now);

        if (realtimeEnabled && pushPublisher != null) {
            long unreadCount = notificationRepository.countUnreadForUser(userId, now);
            pushPublisher.publishRead(userId, notificationId, unreadCount);
        }
    }

    @Override
    @Transactional
    public void markAllAsRead(Long userId) {
        Instant now = Instant.now();
        notificationUserStateRepository.markAllAsReadForUser(userId, now);
        notificationRepository.markAllNotificationsAsReadForUser(userId, now);

        if (realtimeEnabled && pushPublisher != null) {
            pushPublisher.publishAllRead(userId);
        }
    }

    @Override
    @Transactional
    public void dismiss(Long userId, Long notificationId) {
        Instant now = Instant.now();
        boolean isAccessible = notificationRepository.isNotificationAccessibleToUser(notificationId, userId, now);
        if (!isAccessible) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Notification not found or not accessible");
        }
        notificationUserStateRepository.dismiss(notificationId, userId, now);
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<Notification> create(CreateNotificationCommand command) {
        return createInternal(command);
    }

    private Optional<Notification> createInternal(CreateNotificationCommand command) {
        if (command == null || command.userId() == null) {
            log.warn("[Notifications] Cannot create notification: command or userId is null");
            return Optional.empty();
        }

        // 1. Action URL validation (must be internal route, starts with /, not //, no scheme)
        String actionUrl = command.actionUrl();
        if (actionUrl != null && !actionUrl.isBlank()) {
            actionUrl = actionUrl.trim();
            if (!isValidActionUrl(actionUrl)) {
                log.warn("[Notifications] Rejected invalid actionUrl: {}", actionUrl);
                actionUrl = null;
            }
        } else {
            actionUrl = null;
        }

        // 2. Deduplication check (fast path in DB)
        String normalizedDedupeKey = (command.dedupeKey() != null && !command.dedupeKey().isBlank())
                ? command.dedupeKey().trim()
                : null;
        if (normalizedDedupeKey != null) {
            boolean exists = notificationRepository.existsByUserIdAndDedupeKey(command.userId(), normalizedDedupeKey);
            if (exists) {
                log.debug("[Notifications] Duplicate notification skipped for userId={}, dedupeKey={}",
                        command.userId(), normalizedDedupeKey);
                return Optional.empty();
            }
        }

        // 3. User preference check (P1)
        if (!isCategoryAllowedForUser(command.userId(), command.category())) {
            log.debug("[Notifications] Notification category {} disabled by user preferences for userId={}",
                    command.category(), command.userId());
            return Optional.empty();
        }

        // 4. Persistence via native ON CONFLICT DO NOTHING (eliminates 25P02 aborted-transaction poisoning on duplicates)
        Instant now = Instant.now();
        NotificationCategory category = command.category() != null ? command.category() : NotificationCategory.SYSTEM;
        String title = command.title() != null ? command.title().trim() : "";
        String body = command.content() != null ? command.content().trim() : "";

        Optional<Long> insertedIdOpt = notificationRepository.insertUserNotificationIdempotent(
                command.type().name(),
                category.name(),
                command.userId(),
                NotificationTemplates.BRANDING_SENDER,
                title,
                body,
                actionUrl,
                normalizedDedupeKey,
                now
        );
        if (insertedIdOpt == null || insertedIdOpt.isEmpty()) {
            log.debug("[Notifications] Duplicate key skipped via ON CONFLICT for userId={}, dedupeKey={}",
                    command.userId(), normalizedDedupeKey);
            return Optional.empty();
        }

        Notification saved = Notification.builder()
                .id(insertedIdOpt.get())
                .scope(NotificationScope.USER)
                .type(command.type())
                .category(category)
                .userId(command.userId())
                .targetUserId(command.userId())
                .sender(NotificationTemplates.BRANDING_SENDER)
                .title(title)
                .body(body)
                .actionUrl(actionUrl)
                .dedupeKey(normalizedDedupeKey)
                .isRead(false)
                .publishAt(now)
                .createdAt(now)
                .updatedAt(now)
                .build();

        log.info("[Notifications] Persisted notification id={}, category={}, userId={}, dedupeKey={}",
                saved.getId(), saved.getCategory(), saved.getUserId(), saved.getDedupeKey());

        // 5. Real-time push (accelerator only, after persistence; failure never rolls back DB)
        if (realtimeEnabled && pushPublisher != null) {
            try {
                long unreadCount = notificationRepository.countUnreadForUser(command.userId(), now);
                pushPublisher.publishCreated(command.userId(), saved, unreadCount);
            } catch (Exception e) {
                log.warn("[Notifications] Real-time push failed for userId={}, notifId={}: {}",
                        command.userId(), saved.getId(), e.getMessage());
            }
        }

        return Optional.of(saved);
    }

    @Override
    @Transactional
    public AdminNotificationDto createNotificationByAdmin(Long adminUserId, AdminCreateNotificationRequest request) {
        if (request.type() != NotificationType.SYSTEM_UPDATE && request.type() != NotificationType.EVENT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Admin manual notifications only support SYSTEM_UPDATE or EVENT type");
        }

        Long targetUserId = null;
        String resolvedTargetEmail = null;

        if (request.scope() == NotificationScope.USER) {
            if (request.targetEmail() == null || request.targetEmail().isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Target email is required when notification scope is USER");
            }
            String normalizedEmail = request.targetEmail().trim().toLowerCase();
            User targetUser = userRepository.findByEmailNormalized(normalizedEmail)
                    .or(() -> userRepository.findByEmail(request.targetEmail().trim()))
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                            "User with email '" + request.targetEmail().trim() + "' not found"));
            targetUserId = targetUser.getId();
            resolvedTargetEmail = targetUser.getEmail();
        } else if (request.scope() == NotificationScope.GLOBAL) {
            if (request.targetEmail() != null && !request.targetEmail().isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "targetEmail must be empty when notification scope is GLOBAL");
            }
        }

        String actionUrl = null;
        if (request.actionUrl() != null && !request.actionUrl().isBlank()) {
            actionUrl = request.actionUrl().trim();
            if (!isValidActionUrl(actionUrl)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Invalid actionUrl: must be an internal path starting with a single '/' and cannot be external");
            }
        }

        Instant publishAt = request.publishAt() != null ? request.publishAt() : Instant.now();
        Instant expiresAt = request.expiresAt();

        if (expiresAt != null && !expiresAt.isAfter(publishAt)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "expiresAt must be after publishAt");
        }

        Notification notification = Notification.builder()
                .scope(request.scope())
                .type(request.type())
                .category(NotificationCategory.SYSTEM)
                .sender(NotificationTemplates.BRANDING_SENDER)
                .userId(targetUserId)
                .targetUserId(targetUserId)
                .title(request.title().trim())
                .body(request.body().trim())
                .actionUrl(actionUrl)
                .publishAt(publishAt)
                .expiresAt(expiresAt)
                .createdByUserId(adminUserId)
                .build();

        Notification saved = notificationRepository.save(notification);
        log.info("[Notifications] Created {} notification id={} by admin user id={}",
                saved.getScope(), saved.getId(), adminUserId);

        if (saved.getScope() == NotificationScope.GLOBAL) {
            evictGlobalNotificationsCacheAfterCommit();
            if (pushPublisher != null) {
                pushPublisher.publishSystemAnnouncement(saved.getId(), saved.getTitle());
            }
            try {
                if (messagingTemplate != null) {
                    messagingTemplate.convertAndSend("/topic/notifications/broadcast", Map.of(
                            "type", "BROADCAST",
                            "notificationId", saved.getId(),
                            "title", saved.getTitle(),
                            "createdAt", saved.getCreatedAt() != null ? saved.getCreatedAt().toString() : Instant.now().toString()
                    ));
                }
            } catch (Exception e) {
                log.warn("[Notifications] Failed to broadcast notification id={}: {}", saved.getId(), e.getMessage());
            }
        } else if (saved.getScope() == NotificationScope.USER && saved.getTargetUserId() != null) {
            if (pushPublisher != null) {
                long unread = notificationRepository.countUnreadForUser(saved.getTargetUserId(), Instant.now());
                pushPublisher.publishCreated(saved.getTargetUserId(), saved, unread);
            }
        }

        return toAdminDto(saved, resolvedTargetEmail);
    }

    @Override
    @Transactional(readOnly = true)
    public List<AdminNotificationDto> getAdminNotifications(int page, int size) {
        int boundedSize = (size > 0) ? Math.min(size, 100) : 50;
        PageRequest pageRequest = PageRequest.of(Math.max(0, page), boundedSize);
        Page<Notification> pageResult = notificationRepository.findAllByOrderByCreatedAtDesc(pageRequest);

        List<Notification> notifications = pageResult.getContent();
        List<Long> targetUserIds = notifications.stream()
                .map(Notification::getTargetUserId)
                .filter(Objects::nonNull)
                .distinct()
                .toList();

        Map<Long, String> userEmailMap = targetUserIds.isEmpty() ? Map.of() :
                userRepository.findAllById(targetUserIds).stream()
                        .collect(Collectors.toMap(User::getId, User::getEmail));

        return notifications.stream()
                .map(n -> toAdminDto(n, n.getTargetUserId() != null ? userEmailMap.get(n.getTargetUserId()) : null))
                .toList();
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void createPaymentSuccessNotification(Long userId, String planName) {
        createInternal(buildPaymentSuccessCommand(userId, planName, null));
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void createPaymentSuccessNotification(Long userId, String planName, Long orderId) {
        createInternal(buildPaymentSuccessCommand(userId, planName, orderId));
    }

    private CreateNotificationCommand buildPaymentSuccessCommand(Long userId, String planName, Long orderId) {
        String title = "Thanh toán Premium thành công";
        String body = (planName != null && !planName.isBlank())
                ? planName + " của bạn đã được kích hoạt."
                : "Gói Premium của bạn đã được kích hoạt thành công.";
        String dedupeKey = orderId != null
                ? "PAYMENT_SUCCESS:" + userId + ":" + orderId
                : "PAYMENT_SUCCESS:" + userId + ":" + Instant.now().getEpochSecond();

        return new CreateNotificationCommand(
                userId,
                NotificationCategory.SYSTEM,
                NotificationType.PAYMENT,
                title,
                body,
                "/premium",
                dedupeKey
        );
    }

    @Override
    @Transactional
    public void cleanupOldReadNotifications() {
        Instant threshold = Instant.now().minus(90, ChronoUnit.DAYS);
        int deleted = notificationRepository.deleteReadNotificationsOlderThan(threshold);
        log.info("[Notifications Retention] Deleted {} read notifications older than 90 days", deleted);
    }

    @Override
    @Transactional
    public void pruneUserNotificationsCap(int maxPerUser) {
        int cap = maxPerUser > 0 ? maxPerUser : 300;
        int pruned = notificationRepository.pruneUserNotificationsOverCap(cap);
        log.info("[Notifications Retention] Pruned {} excess notifications beyond cap of {}", pruned, cap);
    }

    public static boolean isValidActionUrl(String url) {
        if (url == null || url.isBlank()) {
            return true;
        }
        String trimmed = url.trim();
        if (!trimmed.startsWith("/")) {
            return false;
        }
        if (trimmed.startsWith("//")) {
            return false;
        }
        String lower = trimmed.toLowerCase();
        if (lower.contains("://") || lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("mailto:")) {
            return false;
        }
        return trimmed.length() <= 512;
    }

    private boolean isCategoryAllowedForUser(Long userId, NotificationCategory category) {
        if (category == NotificationCategory.SYSTEM) {
            return true;
        }
        return true;
    }

    private AdminNotificationDto toAdminDto(Notification notification, String targetEmail) {
        Instant now = Instant.now();
        String state;
        if (notification.getExpiresAt() != null && notification.getExpiresAt().isBefore(now)) {
            state = "EXPIRED";
        } else if (notification.getPublishAt().isAfter(now)) {
            state = "SCHEDULED";
        } else {
            state = "PUBLISHED";
        }

        return new AdminNotificationDto(
                notification.getId(),
                notification.getScope().name(),
                notification.getType().name(),
                notification.getTitle(),
                notification.getBody(),
                notification.getActionUrl(),
                notification.getPublishAt(),
                notification.getExpiresAt(),
                targetEmail,
                notification.getCreatedByUserId(),
                state,
                notification.getCreatedAt()
        );
    }
}
