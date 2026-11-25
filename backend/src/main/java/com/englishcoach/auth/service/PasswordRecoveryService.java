package com.englishcoach.auth.service;

import com.englishcoach.auth.dto.ChangePasswordRequest;
import com.englishcoach.auth.dto.ForgotPasswordRequest;
import com.englishcoach.auth.dto.ResetPasswordRequest;
import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
@Slf4j
public class PasswordRecoveryService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final PasswordPolicyService passwordPolicyService;
    private final AuthActionTokenService actionTokenService;
    private final AuthSessionService sessionService;
    private final AuthMailService mailService;
    private final LoginThrottleService throttleService;
    private final SecurityAuditService auditService;

    @Transactional
    public void forgotPassword(ForgotPasswordRequest request, String ipAddress, String userAgent) {
        // IP rate limit: 10 per hour
        if (!throttleService.checkAndIncrementRateLimit("FORGOT_PASSWORD_IP", ipAddress, 10, 60)) {
            throw new IllegalStateException("Too many password reset requests. Please try again later.");
        }

        String normalizedEmail = request.email().trim().toLowerCase();
        var userOpt = userRepository.findByEmailNormalized(normalizedEmail);

        if (userOpt.isPresent()) {
            User user = userOpt.get();
            if (!"DISABLED".equalsIgnoreCase(user.getAccountStatus())) {
                // Token valid for 15 minutes
                String rawToken = actionTokenService.createActionToken(
                        user,
                        "PASSWORD_RESET",
                        15L,
                        normalizedEmail,
                        null,
                        null,
                        user.getCredentialVersion()
                );
                mailService.queuePasswordResetEmail(user, rawToken);
                auditService.recordEvent("PASSWORD_RESET_REQUESTED", "SUCCESS", null,
                        user.getId(), null, ipAddress, userAgent, null, null);
            }
        } else {
            auditService.recordEvent("PASSWORD_RESET_NONEXISTENT", "SUCCESS", null,
                    null, null, ipAddress, userAgent, null, null);
        }
    }

    @Transactional
    public void resetPassword(ResetPasswordRequest request, String ipAddress) {
        // IP rate limit: 20 per 15 minutes
        if (!throttleService.checkAndIncrementRateLimit("RESET_PASSWORD_IP", ipAddress, 20, 15)) {
            throw new IllegalStateException("Too many attempts. Please try again later.");
        }

        AuthActionToken actionToken = actionTokenService.consumeActionToken(request.token(), "PASSWORD_RESET");
        User user = actionToken.getUser();

        // Validate password against policy
        passwordPolicyService.validatePassword(request.newPassword(), user.getEmail(), user.getName());

        // Update password
        user.setPassword(passwordEncoder.encode(request.newPassword()));
        user.setPasswordChangedAt(LocalDateTime.now());
        user.setCredentialStatus("ACTIVE");
        user.setCredentialVersion(user.getCredentialVersion() + 1);
        if ("PENDING_EMAIL".equalsIgnoreCase(user.getAccountStatus())) {
            user.setAccountStatus("ACTIVE");
        }
        userRepository.save(user);

        // Revoke all active sessions for this user
        sessionService.revokeAllUserSessions(user.getId(), "PASSWORD_RESET");

        // Unlock account if locked
        throttleService.recordSuccessfulLogin(user.getId(), ipAddress);

        auditService.recordEvent("PASSWORD_RESET_COMPLETED", "SUCCESS", null,
                user.getId(), null, ipAddress, null, null, null);
    }

    @Transactional
    public void changePassword(Long userId, ChangePasswordRequest request, String ipAddress) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        // Verify current password
        if (user.getPassword() == null || !passwordEncoder.matches(request.currentPassword(), user.getPassword())) {
            throw new IllegalArgumentException("Current password is incorrect");
        }

        // Validate new password against policy
        passwordPolicyService.validatePassword(request.newPassword(), user.getEmail(), user.getName());

        // Update password
        user.setPassword(passwordEncoder.encode(request.newPassword()));
        user.setPasswordChangedAt(LocalDateTime.now());
        user.setCredentialStatus("ACTIVE");
        user.setCredentialVersion(user.getCredentialVersion() + 1);
        userRepository.save(user);

        // Revoke all other sessions for this user
        sessionService.revokeAllUserSessions(user.getId(), "PASSWORD_CHANGED");

        auditService.recordEvent("PASSWORD_CHANGED", "SUCCESS", null,
                user.getId(), null, ipAddress, null, null, null);
    }
}
