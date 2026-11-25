package com.englishcoach.auth.mail;

import com.englishcoach.common.security.AuthSecurityProperties;
import jakarta.mail.internet.MimeMessage;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

@Component
@RequiredArgsConstructor
@Slf4j
public class SmtpMailDeliveryAdapter implements MailDeliveryAdapter {

    @Autowired(required = false)
    private JavaMailSender mailSender;

    private final AuthSecurityProperties securityProperties;

    @Override
    public MailDeliveryResult sendEmail(String to, String subject, String htmlContent, String textContent) {
        if (mailSender == null) {
            log.warn("[Mail:SMTP] JavaMailSender is not initialized. Outbound mail to {} cannot be sent.", to);
            return MailDeliveryResult.failure("JavaMailSender is not available");
        }

        try {
            MimeMessage mimeMessage = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mimeMessage, true, StandardCharsets.UTF_8.name());

            String from = securityProperties.getMailFrom();
            if (from != null && from.contains("<") && from.endsWith(">")) {
                int start = from.indexOf('<');
                String personal = from.substring(0, start).trim();
                String address = from.substring(start + 1, from.length() - 1).trim();
                helper.setFrom(address, personal);
            } else if (from != null && !from.isBlank()) {
                helper.setFrom(from);
            } else {
                helper.setFrom("no-reply@englishcoach.io.vn", "English Coach");
            }

            helper.setTo(to);
            helper.setSubject(subject);
            helper.setText(textContent, htmlContent);

            mailSender.send(mimeMessage);

            String messageId = mimeMessage.getMessageID();
            if (messageId == null || messageId.isBlank()) {
                messageId = "smtp-" + UUID.randomUUID();
            }

            log.info("[Mail:SMTP] Outbound email accepted by SMTP server for recipient: {} (Subject: '{}', MessageId: {})",
                    com.englishcoach.common.security.LogMask.email(to), subject, messageId);
            return MailDeliveryResult.success(messageId);
        } catch (Exception ex) {
            boolean retryable = isTransient(ex);
            log.error("[Mail:SMTP] Outbound email delivery failed for recipient: {} (Subject: '{}', transient: {}). Reason: {}",
                    com.englishcoach.common.security.LogMask.email(to), subject, retryable, ex.getMessage());
            String reason = ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName();
            return retryable ? MailDeliveryResult.transientFailure(reason) : MailDeliveryResult.failure(reason);
        }
    }

    /** Network-level failures and SMTP 4xx replies may succeed on another attempt; auth errors and 5xx never do. */
    public static boolean isTransient(Throwable ex) {
        for (Throwable t = ex; t != null; t = t.getCause()) {
            if (t instanceof org.springframework.mail.MailAuthenticationException
                    || t instanceof jakarta.mail.AuthenticationFailedException) {
                return false;
            }
            if (t instanceof java.net.SocketTimeoutException || t instanceof java.net.ConnectException
                    || t instanceof java.net.UnknownHostException || t instanceof java.net.SocketException) {
                return true;
            }
            if (t instanceof org.springframework.mail.MailSendException send) {
                // A failed send keeps the per-message exceptions apart from the cause chain.
                for (Exception nested : send.getMessageExceptions()) {
                    if (nested != null && nested != t && isTransient(nested)) return true;
                }
            }
            String message = t.getMessage();
            if (message != null && message.trim().matches("^4\\d\\d[ -].*")) {
                return true;
            }
            if (t.getCause() == t) break;
        }
        return false;
    }

    @Override
    public boolean isLiveDelivery() {
        return true;
    }

    @Override
    public String getAdapterName() {
        return "SMTP";
    }
}
