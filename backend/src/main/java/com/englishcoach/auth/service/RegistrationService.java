package com.englishcoach.auth.service;

import com.englishcoach.auth.dto.RegisterRequest;
import com.englishcoach.auth.dto.ResendVerificationRequest;
import com.englishcoach.auth.dto.VerifyEmailRequest;
import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthMailService.DeliveryOutcome;
import com.englishcoach.auth.service.AuthMailService.PreparedMail;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.Optional;

/**
 * Registration, email verification and resend.
 *
 * <p>Every accepted registration mails the address — a verification link for a new or still-unverified account, an
 * "account already exists" notice for an active one — so the inbox owner always hears back while the web response stays
 * the same for both (no account enumeration). {@link #register} and {@link #resendVerification} only PREPARE the mail in
 * their transaction; the controller calls {@link #deliver} after they returned (committed), so the provider's answer is
 * known and never held inside a database transaction.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class RegistrationService {

    static final String VERIFICATION = "EMAIL_VERIFICATION";
    /** Verification links stay valid for 24 hours. */
    static final long VERIFICATION_MINUTES = 1440L;
    /** Resend mails per account (any outcome) in {@link #RESEND_ACCOUNT_WINDOW_MIN}; bounds mail to one inbox. */
    static final int RESEND_ACCOUNT_MAX = 4;
    static final int RESEND_ACCOUNT_WINDOW_MIN = 30;

    public enum VerifyOutcome { VERIFIED, ALREADY_VERIFIED }

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final PasswordPolicyService passwordPolicyService;
    private final AuthActionTokenService actionTokenService;
    private final AuthMailService mailService;
    private final LoginThrottleService throttleService;
    private final SecurityAuditService auditService;

    /** Creates the account (or recognises the existing one) and prepares the mail for it; never null. */
    @Transactional
    public PreparedMail register(RegisterRequest request, String ipAddress, String userAgent) {
        // IP rate limit: 5 per hour
        if (!throttleService.checkAndIncrementRateLimit("REGISTER_IP", ipAddress, 5, 60)) {
            throw new IllegalStateException("Too many registration attempts from this IP address. Please try again later.");
        }

        String normalizedEmail = request.email().trim().toLowerCase();

        // Check password policy
        passwordPolicyService.validatePassword(request.password(), normalizedEmail, request.name());

        // Check existing user
        var existingOpt = userRepository.findByEmailNormalized(normalizedEmail);
        if (existingOpt.isPresent()) {
            User existing = existingOpt.get();
            // Same response as a new account; the mail tells the inbox owner what is true. The request carried a
            // Turnstile proof and the address limit above bounds how often this can mail one inbox.
            if ("PENDING_EMAIL".equalsIgnoreCase(existing.getAccountStatus())) {
                log.info("[Registration] Re-registration of an unverified address, new verification link: {}",
                        com.englishcoach.common.security.LogMask.email(normalizedEmail));
                auditService.recordEvent("REGISTRATION_SUBMITTED_EXISTING", "SUCCESS", null,
                        existing.getId(), null, ipAddress, userAgent, "VERIFICATION_REISSUED", null);
                return mailService.prepare(existing, VERIFICATION,
                        mailService.verificationContent(existing, newVerificationToken(existing, normalizedEmail)));
            }
            log.info("[Registration] Registration for an existing account, notice mailed: {}",
                    com.englishcoach.common.security.LogMask.email(normalizedEmail));
            auditService.recordEvent("REGISTRATION_SUBMITTED_EXISTING", "SUCCESS", null,
                    existing.getId(), null, ipAddress, userAgent, "ACCOUNT_EXISTS_NOTICE", null);
            return mailService.prepare(existing, "ACCOUNT_EXISTS_NOTICE", mailService.accountExistsContent(existing));
        }

        User newUser = User.builder()
                .name(request.name().trim())
                .email(normalizedEmail)
                .password(passwordEncoder.encode(request.password()))
                .role(Role.ROLE_USER)
                .credentialStatus("ACTIVE")
                .accountStatus("PENDING_EMAIL")
                .credentialVersion(0L)
                .passwordChangedAt(LocalDateTime.now())
                .build();

        userRepository.save(newUser);

        PreparedMail mail = mailService.prepare(newUser, VERIFICATION,
                mailService.verificationContent(newUser, newVerificationToken(newUser, normalizedEmail)));

        auditService.recordEvent("REGISTRATION_SUCCESS", "SUCCESS", null,
                newUser.getId(), null, ipAddress, userAgent, null, null);
        return mail;
    }

    @Transactional
    public VerifyOutcome verifyEmail(VerifyEmailRequest request, String ipAddress) {
        // IP rate limit: 20 per 15 minutes
        if (!throttleService.checkAndIncrementRateLimit("VERIFY_EMAIL_IP", ipAddress, 20, 15)) {
            throw new IllegalStateException("Too many verification attempts. Please try again later.");
        }

        // An old link of an account that is verified by now (opened twice, or an earlier mail after a resend).
        Optional<User> spentHolder = actionTokenService.findUserOfSpentToken(request.token(), VERIFICATION);
        if (spentHolder.isPresent() && spentHolder.get().getEmailVerifiedAt() != null
                && !"PENDING_EMAIL".equalsIgnoreCase(spentHolder.get().getAccountStatus())) {
            return VerifyOutcome.ALREADY_VERIFIED;
        }

        AuthActionToken actionToken = actionTokenService.consumeActionToken(request.token(), VERIFICATION);
        User user = actionToken.getUser();

        if ("PENDING_EMAIL".equalsIgnoreCase(user.getAccountStatus())) {
            user.setAccountStatus("ACTIVE");
        }
        user.setEmailVerifiedAt(LocalDateTime.now());
        user.setEmailVerificationSource("EMAIL_CHALLENGE");
        userRepository.save(user);
        actionTokenService.revokeRemaining(user.getId(), VERIFICATION);

        auditService.recordEvent("EMAIL_VERIFIED", "SUCCESS", null,
                user.getId(), null, ipAddress, null, null, null);
        return VerifyOutcome.VERIFIED;
    }

    /**
     * Prepares the mail for a resend request: a new verification link (earlier links stay valid) for an unverified
     * account, an "already verified" notice for a verified one, nothing for an unknown address or above the per-account
     * limit. The web response is the same in every case.
     */
    @Transactional
    public Optional<PreparedMail> resendVerification(ResendVerificationRequest request, String ipAddress) {
        // IP rate limit: 10 per hour
        if (!throttleService.checkAndIncrementRateLimit("RESEND_VERIFY_IP", ipAddress, 10, 60)) {
            throw new IllegalStateException("Too many resend attempts. Please try again later.");
        }

        String normalizedEmail = request.email().trim().toLowerCase();
        var userOpt = userRepository.findByEmailNormalized(normalizedEmail);
        if (userOpt.isEmpty()) {
            return Optional.empty();
        }

        User user = userOpt.get();
        if (!throttleService.checkAndIncrementRateLimit("RESEND_VERIFY_USER", String.valueOf(user.getId()),
                RESEND_ACCOUNT_MAX, RESEND_ACCOUNT_WINDOW_MIN)) {
            auditService.recordEvent("VERIFICATION_RESENT", "FAILURE", null,
                    user.getId(), null, ipAddress, null, "ACCOUNT_LIMIT", null);
            return Optional.empty();
        }

        if ("PENDING_EMAIL".equalsIgnoreCase(user.getAccountStatus()) || user.getEmailVerifiedAt() == null) {
            PreparedMail mail = mailService.prepare(user, VERIFICATION,
                    mailService.verificationContent(user, newVerificationToken(user, normalizedEmail)));
            auditService.recordEvent("VERIFICATION_RESENT", "SUCCESS", null,
                    user.getId(), null, ipAddress, null, null, null);
            return Optional.of(mail);
        }

        auditService.recordEvent("VERIFICATION_RESENT", "SUCCESS", null,
                user.getId(), null, ipAddress, null, "ALREADY_VERIFIED_NOTICE", null);
        return Optional.of(mailService.prepare(user, "ALREADY_VERIFIED_NOTICE", mailService.alreadyVerifiedContent(user)));
    }

    /**
     * Hands a prepared mail to the provider. Not transactional on purpose: call it after {@link #register} /
     * {@link #resendVerification} returned, i.e. after their transaction committed.
     */
    public DeliveryOutcome deliver(PreparedMail mail) {
        return mailService.deliver(mail);
    }

    private String newVerificationToken(User user, String normalizedEmail) {
        return actionTokenService.createActionToken(
                user,
                VERIFICATION,
                VERIFICATION_MINUTES,
                normalizedEmail,
                null,
                null,
                user.getCredentialVersion(),
                false
        );
    }
}
