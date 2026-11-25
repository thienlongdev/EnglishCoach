package com.englishcoach.auth.service;

import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.SecuritySignals;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Security alerts to the owner ({@code APP_SECURITY_ALERT_EMAIL}, sent through the application's existing mail
 * adapter). Two kinds of rule:
 * <ul>
 *   <li><b>immediate</b> — every occurrence matters: an administrator second factor added or removed, recovery codes
 *       regenerated, the emergency reset, a second-factor lock-out, an administrator ending another user's sessions,
 *       a payment transfer that could not be matched, and every backend start (which doubles as the delivery test);</li>
 *   <li><b>burst</b> — a count inside a sliding window: CSRF refusals, refused internal calls, failed sign-ins,
 *       account lock-outs.</li>
 * </ul>
 * One alert per kind per {@link #DEDUPE} at most and {@link #DAILY_CAP} a day in total, so an attack cannot turn the
 * alerts into a mail flood. Sending happens on its own thread and never delays or fails the request that raised it.
 * Alert text carries kinds, counts, reason categories and times only: never an address, an e-mail, a token or content.
 */
@Service
@Slf4j
public class SecurityAlertService implements SecuritySignals.Listener {

    static final Duration DEDUPE = Duration.ofMinutes(10);
    static final Duration WINDOW = Duration.ofMinutes(10);
    static final int DAILY_CAP = 30;

    static final Set<String> IMMEDIATE = Set.of(
            "MFA_EMERGENCY_RESET", "MFA_FACTOR_ENROLLED", "MFA_FACTOR_REMOVED", "MFA_RECOVERY_CODES_REGENERATED",
            "MFA_LOCKED", "ADMIN_SESSIONS_REVOKED", "PAYMENT_UNMATCHED", "BACKEND_STARTED");
    static final Map<String, Integer> BURST = Map.of(
            "CSRF_REJECTED", 25, "INTERNAL_AUTH_REFUSED", 5, "LOGIN_FAILED", 100, "ACCOUNT_TEMP_LOCKED", 10);

    /** Delivery seam: (recipient, subject, text) → delivered? */
    public interface Sender {
        boolean send(String to, String subject, String text);
    }

    private final String recipient;
    private final Sender sender;
    private final Clock clock;
    private final ExecutorService executor;
    private final Map<String, Instant> lastSent = new ConcurrentHashMap<>();
    private final Map<String, Deque<Instant>> windows = new ConcurrentHashMap<>();
    private final Deque<Instant> sentToday = new ArrayDeque<>();

    @org.springframework.beans.factory.annotation.Autowired
    public SecurityAlertService(AuthSecurityProperties properties, AuthMailService mail) {
        this(properties.getAlertEmail(), (to, subject, text) -> mail.getActiveAdapter()
                .sendEmail(to, subject, "<pre style=\"font-family:monospace\">" + escape(text) + "</pre>", text)
                .delivered(), Clock.systemUTC(), Executors.newSingleThreadExecutor(r -> {
                    Thread t = new Thread(r, "security-alerts");
                    t.setDaemon(true);
                    return t;
                }));
        SecuritySignals.register(this);
    }

    SecurityAlertService(String recipient, Sender sender, Clock clock, ExecutorService executor) {
        this.recipient = recipient == null ? "" : recipient.trim();
        this.sender = sender;
        this.clock = clock;
        this.executor = executor;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onStarted() {
        onSignal("BACKEND_STARTED", "startup");
    }

    @Override
    public void onSignal(String kind, String reason) {
        if (kind == null) return;
        Instant now = clock.instant();
        if (IMMEDIATE.contains(kind)) {
            raise(kind, "Sự kiện bảo mật: " + kind + " (" + safe(reason) + ")", now);
            return;
        }
        Integer threshold = BURST.get(kind);
        if (threshold == null) return;
        int count;
        Deque<Instant> window = windows.computeIfAbsent(kind, k -> new ArrayDeque<>());
        synchronized (window) {
            window.addLast(now);
            while (!window.isEmpty() && window.peekFirst().isBefore(now.minus(WINDOW))) window.removeFirst();
            count = window.size();
        }
        if (count >= threshold) {
            raise(kind, "Đột biến: " + count + " lần " + kind + " trong " + WINDOW.toMinutes()
                    + " phút (ngưỡng " + threshold + "). Lý do gần nhất: " + safe(reason), now);
        }
    }

    /** Audit events that map onto alert kinds (called by {@link SecurityAuditService}). */
    public static String kindOfAudit(String eventType, String outcome, String reasonCode) {
        if (eventType == null) return null;
        if ("MFA_VERIFY".equals(eventType) && "LOCKED".equals(reasonCode)) return "MFA_LOCKED";
        if ("LOGIN_FAILED".equals(eventType) || "ACCOUNT_TEMP_LOCKED".equals(eventType)) return eventType;
        return IMMEDIATE.contains(eventType) ? eventType : null;
    }

    private void raise(String kind, String line, Instant now) {
        Instant previous = lastSent.get(kind);
        if (previous != null && previous.isAfter(now.minus(DEDUPE))) return;
        synchronized (sentToday) {
            while (!sentToday.isEmpty() && sentToday.peekFirst().isBefore(now.minus(Duration.ofDays(1)))) sentToday.removeFirst();
            if (sentToday.size() >= DAILY_CAP) {
                log.warn("[Security:Alert] Daily alert cap reached; {} not mailed", kind);
                return;
            }
            sentToday.addLast(now);
        }
        lastSent.put(kind, now);
        log.warn("[Security:Alert] {}", line);
        if (recipient.isEmpty()) return;
        String subject = "[English Coach] Cảnh báo bảo mật: " + kind;
        String text = line + "\n\nThời điểm (UTC): " + now + "\nMáy chủ: englishcoach.io.vn backend"
                + "\n\nXem hướng dẫn xử lý: docs/security/final-security-v3-2026-10/11-PRIVACY-INCIDENT-OPERATIONS-AND-SECURITY-MAINTENANCE.md"
                + "\nThư này không chứa mật khẩu, mã, địa chỉ IP hay dữ liệu học viên.";
        executor.execute(() -> {
            try {
                if (!sender.send(recipient, subject, text)) log.warn("[Security:Alert] Mail delivery of {} failed", kind);
            } catch (Exception e) {
                log.warn("[Security:Alert] Mail delivery of {} failed: {}", kind, e.getClass().getSimpleName());
            }
        });
    }

    private static String safe(String reason) {
        if (reason == null) return "-";
        String cleaned = reason.replaceAll("[^A-Za-z0-9_ .:-]", "");
        return cleaned.length() > 60 ? cleaned.substring(0, 60) : cleaned;
    }

    private static String escape(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @PreDestroy
    void stop() {
        executor.shutdown();
    }
}
