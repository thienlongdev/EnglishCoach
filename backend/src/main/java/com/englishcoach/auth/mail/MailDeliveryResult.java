package com.englishcoach.auth.mail;

/**
 * Outcome of ONE hand-over attempt to the mail provider. {@code delivered} means the provider ACCEPTED the message
 * (SMTP 250); it never proves that the message reached an inbox. {@code transientFailure} marks failures worth one
 * more attempt (network, timeout, SMTP 4xx); authentication errors and SMTP 5xx are permanent.
 */
public record MailDeliveryResult(
        boolean delivered,
        boolean simulated,
        String providerMessageId,
        String failureReason,
        boolean transientFailure
) {
    public static MailDeliveryResult success(String providerMessageId) {
        return new MailDeliveryResult(true, false, providerMessageId, null, false);
    }

    public static MailDeliveryResult asSimulated() {
        return new MailDeliveryResult(false, true, null, null, false);
    }

    public static MailDeliveryResult failure(String failureReason) {
        return new MailDeliveryResult(false, false, null, failureReason, false);
    }

    public static MailDeliveryResult transientFailure(String failureReason) {
        return new MailDeliveryResult(false, false, null, failureReason, true);
    }
}
