package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthMailJob;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.mail.AuthEmailTemplateService;
import com.englishcoach.auth.mail.AuthEmailTemplateService.EmailContent;
import com.englishcoach.auth.mail.MailDeliveryAdapter;
import com.englishcoach.auth.mail.MailDeliveryResult;
import com.englishcoach.auth.mail.SimulatedMailDeliveryAdapter;
import com.englishcoach.auth.mail.SmtpMailDeliveryAdapter;
import com.englishcoach.auth.repository.AuthMailJobRepository;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.LogMask;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.UUID;

/**
 * Transactional account mail. A mail is PREPARED inside the caller's transaction (an {@code auth_mail_jobs} row, the
 * rendered content in memory only — the raw token never reaches the database) and DELIVERED once that transaction has
 * committed, so a link is never mailed for a token that a rollback discarded and no database connection waits on the
 * provider. {@link DeliveryOutcome#SENT} means the provider accepted the message, never that it reached an inbox.
 */
@Service
@Slf4j
public class AuthMailService {

    /** What the provider said about one prepared mail (after at most {@link #MAX_ATTEMPTS} attempts). */
    public enum DeliveryOutcome { SENT, SIMULATED, FAILED }

    /** A mail whose job row exists and whose content waits for delivery. Content stays in memory only. */
    public record PreparedMail(UUID jobId, String purpose, String recipient, EmailContent content) {}

    static final int MAX_ATTEMPTS = 2;
    static final long RETRY_PAUSE_MS = 1_500;

    private final AuthMailJobRepository mailJobRepository;
    private final AuthSecurityProperties securityProperties;
    private final AuthEmailTemplateService templateService;
    private final SmtpMailDeliveryAdapter smtpAdapter;
    private final SimulatedMailDeliveryAdapter simulatedAdapter;
    private final Environment environment;
    /** Status writes after a commit must not join the finished transaction (Spring's afterCommit contract). */
    private final TransactionTemplate statusTx;

    @Autowired
    public AuthMailService(AuthMailJobRepository mailJobRepository, AuthSecurityProperties securityProperties,
                           AuthEmailTemplateService templateService, SmtpMailDeliveryAdapter smtpAdapter,
                           SimulatedMailDeliveryAdapter simulatedAdapter, Environment environment,
                           ObjectProvider<PlatformTransactionManager> transactionManager) {
        this.mailJobRepository = mailJobRepository;
        this.securityProperties = securityProperties;
        this.templateService = templateService;
        this.smtpAdapter = smtpAdapter;
        this.simulatedAdapter = simulatedAdapter;
        this.environment = environment;
        PlatformTransactionManager manager = transactionManager == null ? null : transactionManager.getIfAvailable();
        if (manager != null) {
            TransactionTemplate tx = new TransactionTemplate(manager);
            tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            this.statusTx = tx;
        } else {
            this.statusTx = null;
        }
    }

    /** Unit tests: no transaction manager, delivery and status writes run directly. */
    public AuthMailService(AuthMailJobRepository mailJobRepository, AuthSecurityProperties securityProperties,
                           AuthEmailTemplateService templateService, SmtpMailDeliveryAdapter smtpAdapter,
                           SimulatedMailDeliveryAdapter simulatedAdapter, Environment environment) {
        this(mailJobRepository, securityProperties, templateService, smtpAdapter, simulatedAdapter, environment, null);
    }

    /**
     * Resolve the active MailDeliveryAdapter based on mailMode and environment.
     */
    public MailDeliveryAdapter getActiveAdapter() {
        String mode = securityProperties.getMailMode();
        if ("simulated".equalsIgnoreCase(mode)) {
            return simulatedAdapter;
        }
        if ("smtp".equalsIgnoreCase(mode)) {
            return smtpAdapter;
        }
        // "auto" mode: use SMTP if mail host is configured and non-blank; otherwise fall back to SIMULATED
        String host = (environment != null) ? environment.getProperty("spring.mail.host") : null;
        if (host != null && !host.isBlank()) {
            return smtpAdapter;
        }
        return simulatedAdapter;
    }

    public EmailContent verificationContent(User user, String rawToken) {
        return templateService.buildVerificationEmail(user.getName(), rawToken);
    }

    public EmailContent accountExistsContent(User user) {
        return templateService.buildAccountExistsEmail(user.getName());
    }

    public EmailContent alreadyVerifiedContent(User user) {
        return templateService.buildAlreadyVerifiedEmail(user.getName());
    }

    /** Writes the job row (status PENDING) in the caller's transaction; delivery is the caller's next step. */
    @Transactional
    public PreparedMail prepare(User user, String purpose, EmailContent content) {
        log.info("[Mail:Dispatch] Preparing {} mail for recipient: {}", purpose, LogMask.email(user.getEmail()));
        AuthMailJob job = AuthMailJob.builder()
                .user(user)
                .purpose(purpose)
                .recipientEmail(user.getEmail())
                .status("PENDING")
                .attemptCount(0)
                .nextAttemptAt(Instant.now())
                .build();
        job = mailJobRepository.save(job);
        return new PreparedMail(job.getId(), purpose, user.getEmail(), content);
    }

    /** Verification mail delivered after the caller's transaction commits (or at once without one). */
    @Transactional
    public void queueVerificationEmail(User user, String rawToken) {
        deliverAfterCommit(prepare(user, "EMAIL_VERIFICATION", verificationContent(user, rawToken)));
    }

    /** Password reset mail delivered after the caller's transaction commits (or at once without one). */
    @Transactional
    public void queuePasswordResetEmail(User user, String rawToken) {
        deliverAfterCommit(prepare(user, "PASSWORD_RESET", templateService.buildPasswordResetEmail(user.getName(), rawToken)));
    }

    private void deliverAfterCommit(PreparedMail mail) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    deliver(mail);
                }
            });
        } else {
            deliver(mail);
        }
    }

    /**
     * Hands a prepared mail to the provider: one more attempt after a transient failure, never after a permanent one.
     * Must be called OUTSIDE the transaction that prepared it. Never throws.
     */
    public DeliveryOutcome deliver(PreparedMail mail) {
        if (mail == null) return DeliveryOutcome.FAILED;
        MailDeliveryAdapter adapter = getActiveAdapter();
        String masked = LogMask.email(mail.recipient());
        log.info("[Mail:Dispatch] Delivering job {} ({}) to {} using adapter: {}",
                mail.jobId(), mail.purpose(), masked, adapter.getAdapterName());

        MailDeliveryResult result = null;
        int attempts = 0;
        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            try {
                EmailContent c = mail.content();
                result = adapter.sendEmail(mail.recipient(), c.subject(), c.htmlContent(), c.textContent());
            } catch (Exception ex) {
                result = MailDeliveryResult.failure(ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName());
            }
            if (result == null || result.delivered() || result.simulated() || !result.transientFailure()) break;
            if (attempts < MAX_ATTEMPTS) {
                log.warn("[Mail:Delivery] Transient failure for job {} (attempt {}), retrying once", mail.jobId(), attempts);
                try {
                    Thread.sleep(RETRY_PAUSE_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        DeliveryOutcome outcome;
        String error = null;
        if (result != null && result.delivered()) {
            outcome = DeliveryOutcome.SENT;
            log.info("[Mail:Delivery] Outbound mail {} accepted by provider for {} (MessageId: {}, attempts: {})",
                    mail.jobId(), masked, result.providerMessageId(), attempts);
        } else if (result != null && result.simulated()) {
            outcome = DeliveryOutcome.SIMULATED;
            log.info("[Mail:Delivery] Mail {} marked as SIMULATED for {} (Adapter: {})", mail.jobId(), masked, adapter.getAdapterName());
        } else {
            outcome = DeliveryOutcome.FAILED;
            error = result != null && result.failureReason() != null ? result.failureReason() : "Provider rejected delivery";
            log.error("[Mail:Delivery] Mail delivery failed for job {} to {} after {} attempt(s). Reason: {}",
                    mail.jobId(), masked, attempts, error);
        }
        recordOutcome(mail.jobId(), outcome, attempts, error);
        return outcome;
    }

    private void recordOutcome(UUID jobId, DeliveryOutcome outcome, int attempts, String error) {
        Runnable write = () -> mailJobRepository.findById(jobId).ifPresent(job -> {
            job.setStatus(outcome.name());
            job.setAttemptCount(job.getAttemptCount() + attempts);
            job.setCompletedAt(outcome == DeliveryOutcome.FAILED ? null : Instant.now());
            job.setLastError(error);
            mailJobRepository.save(job);
        });
        try {
            if (statusTx != null) {
                statusTx.executeWithoutResult(status -> write.run());
            } else {
                write.run();
            }
        } catch (Exception ex) {
            // The mail itself is already handed over (or failed); a lost status row must not turn into an error page.
            log.error("[Mail:Delivery] Could not record outcome {} of job {}: {}", outcome, jobId, ex.getMessage());
        }
    }
}
