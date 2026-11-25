package com.englishcoach.auth.service;

import com.englishcoach.auth.dto.RegisterRequest;
import com.englishcoach.auth.dto.ResendVerificationRequest;
import com.englishcoach.auth.dto.VerifyEmailRequest;
import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.AuthMailJob;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.mail.*;
import com.englishcoach.auth.repository.AuthMailJobRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthMailService.DeliveryOutcome;
import com.englishcoach.auth.service.AuthMailService.PreparedMail;
import com.englishcoach.common.security.AuthSecurityProperties;
import jakarta.mail.Session;
import jakarta.mail.internet.MimeMessage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.env.Environment;
import org.springframework.mail.MailAuthenticationException;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.ConnectException;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AuthMailDeliveryTest {

    @Mock
    private AuthMailJobRepository mailJobRepository;
    @Mock
    private JavaMailSender javaMailSender;
    @Mock
    private Environment environment;
    @Mock
    private UserRepository userRepository;
    @Mock
    private PasswordEncoder passwordEncoder;
    @Mock
    private PasswordPolicyService passwordPolicyService;
    @Mock
    private AuthActionTokenService actionTokenService;
    @Mock
    private LoginThrottleService throttleService;
    @Mock
    private SecurityAuditService auditService;

    private AuthSecurityProperties securityProperties;
    private AuthEmailTemplateService templateService;
    private SimulatedMailDeliveryAdapter simulatedAdapter;
    private SmtpMailDeliveryAdapter smtpAdapter;
    private AuthMailService mailService;
    private RegistrationService registrationService;

    /** Stand-in for the job table: the last state written per job id. */
    private final Map<UUID, AuthMailJob> jobs = new HashMap<>();

    private User testUser;

    @BeforeEach
    void setUp() {
        securityProperties = new AuthSecurityProperties();
        securityProperties.setBaseUrl("https://englishcoach.io.vn");
        securityProperties.setMailFrom("English Coach <no-reply@englishcoach.io.vn>");
        securityProperties.setMailMode("auto");

        templateService = new AuthEmailTemplateService(securityProperties);
        simulatedAdapter = new SimulatedMailDeliveryAdapter();
        smtpAdapter = new SmtpMailDeliveryAdapter(securityProperties);
        ReflectionTestUtils.setField(smtpAdapter, "mailSender", javaMailSender);

        mailService = new AuthMailService(
                mailJobRepository,
                securityProperties,
                templateService,
                smtpAdapter,
                simulatedAdapter,
                environment
        );

        registrationService = new RegistrationService(
                userRepository,
                passwordEncoder,
                passwordPolicyService,
                actionTokenService,
                mailService,
                throttleService,
                auditService
        );

        testUser = User.builder()
                .id(999L)
                .name("Alex Learner")
                .email("alex@example.com")
                .role(Role.ROLE_USER)
                .accountStatus("PENDING_EMAIL")
                .credentialStatus("ACTIVE")
                .credentialVersion(0L)
                .build();

        jobs.clear();
        lenient().when(mailJobRepository.save(any(AuthMailJob.class))).thenAnswer(invocation -> {
            AuthMailJob job = invocation.getArgument(0);
            if (job.getId() == null) {
                job.setId(UUID.randomUUID());
            }
            jobs.put(job.getId(), job);
            return job;
        });
        lenient().when(mailJobRepository.findById(any(UUID.class)))
                .thenAnswer(invocation -> Optional.ofNullable(jobs.get(invocation.<UUID>getArgument(0))));
    }

    private AuthMailJob onlyJob() {
        assertThat(jobs).hasSize(1);
        return jobs.values().iterator().next();
    }

    private void smtpReady() {
        securityProperties.setMailMode("smtp");
        lenient().when(javaMailSender.createMimeMessage()).thenAnswer(i -> new MimeMessage(Session.getInstance(new Properties())));
    }

    @Test
    @DisplayName("Simulated mode marks job honestly as SIMULATED and never as falsely SENT")
    void testSimulatedModeMarksSimulated() {
        securityProperties.setMailMode("simulated");
        String rawToken = "super-secret-raw-verification-token-123";

        mailService.queueVerificationEmail(testUser, rawToken);

        AuthMailJob finalJob = onlyJob();
        assertThat(finalJob.getStatus()).isEqualTo("SIMULATED");
        assertThat(finalJob.getRecipientEmail()).isEqualTo("alex@example.com");
        assertThat(finalJob.getPurpose()).isEqualTo("EMAIL_VERIFICATION");
        assertThat(finalJob.getAttemptCount()).isEqualTo(1);
        assertThat(finalJob.getCompletedAt()).isNotNull();
        assertThat(finalJob.getLastError()).isNull();

        // Ensure raw token is NEVER persisted in the mail job
        assertThat(finalJob.toString()).doesNotContain(rawToken);
    }

    @Test
    @DisplayName("Production SMTP mode marks job as SENT when provider succeeds")
    void testSmtpSuccessMarksSent() {
        smtpReady();
        doNothing().when(javaMailSender).send(any(MimeMessage.class));

        mailService.queueVerificationEmail(testUser, "secret-token-xyz-456");

        AuthMailJob finalJob = onlyJob();
        assertThat(finalJob.getStatus()).isEqualTo("SENT");
        assertThat(finalJob.getRecipientEmail()).isEqualTo("alex@example.com");
        assertThat(finalJob.getAttemptCount()).isEqualTo(1);
        assertThat(finalJob.getCompletedAt()).isNotNull();
        assertThat(finalJob.getLastError()).isNull();
    }

    @Test
    @DisplayName("A permanent provider failure (authentication) is FAILED after ONE attempt, no retry")
    void testSmtpPermanentFailureMarksFailedWithoutRetry() {
        smtpReady();
        doThrow(new MailAuthenticationException("535 Authentication failed"))
                .when(javaMailSender).send(any(MimeMessage.class));

        mailService.queueVerificationEmail(testUser, "secret-token-xyz-789");

        AuthMailJob finalJob = onlyJob();
        assertThat(finalJob.getStatus()).isEqualTo("FAILED");
        assertThat(finalJob.getAttemptCount()).isEqualTo(1);
        assertThat(finalJob.getCompletedAt()).isNull();
        assertThat(finalJob.getLastError()).contains("535");
        verify(javaMailSender, times(1)).send(any(MimeMessage.class));
    }

    @Test
    @DisplayName("A transient failure (connection) is retried once; success on the second attempt is SENT")
    void testTransientFailureRetriedOnce() {
        smtpReady();
        doThrow(new MailSendException("Mail server connection failed", new ConnectException("Connection refused")))
                .doNothing()
                .when(javaMailSender).send(any(MimeMessage.class));

        PreparedMail mail = mailService.prepare(testUser, "EMAIL_VERIFICATION", mailService.verificationContent(testUser, "tok"));
        DeliveryOutcome outcome = mailService.deliver(mail);

        assertThat(outcome).isEqualTo(DeliveryOutcome.SENT);
        assertThat(onlyJob().getStatus()).isEqualTo("SENT");
        assertThat(onlyJob().getAttemptCount()).isEqualTo(2);
        verify(javaMailSender, times(2)).send(any(MimeMessage.class));
    }

    @Test
    @DisplayName("A transient failure that persists is FAILED after exactly two attempts")
    void testTransientFailureBounded() {
        smtpReady();
        doThrow(new MailSendException("Mail server connection failed", new ConnectException("Connection refused")))
                .when(javaMailSender).send(any(MimeMessage.class));

        PreparedMail mail = mailService.prepare(testUser, "EMAIL_VERIFICATION", mailService.verificationContent(testUser, "tok"));
        assertThat(mailService.deliver(mail)).isEqualTo(DeliveryOutcome.FAILED);
        assertThat(onlyJob().getStatus()).isEqualTo("FAILED");
        assertThat(onlyJob().getAttemptCount()).isEqualTo(2);
        verify(javaMailSender, times(2)).send(any(MimeMessage.class));
    }

    @Test
    @DisplayName("SMTP 4xx is transient, 5xx and authentication are permanent")
    void testTransientClassification() {
        assertThat(SmtpMailDeliveryAdapter.isTransient(new MailSendException("451 4.3.0 Try again later"))).isTrue();
        assertThat(SmtpMailDeliveryAdapter.isTransient(new MailSendException("x", new java.net.SocketTimeoutException("Read timed out")))).isTrue();
        assertThat(SmtpMailDeliveryAdapter.isTransient(new MailSendException("550 5.7.1 Domain not verified"))).isFalse();
        assertThat(SmtpMailDeliveryAdapter.isTransient(new MailAuthenticationException("535 bad credentials"))).isFalse();
    }

    @Test
    @DisplayName("Prepare writes a PENDING job and sends nothing; delivery happens only on deliver()")
    void testPrepareDoesNotSend() {
        smtpReady();
        mailService.prepare(testUser, "EMAIL_VERIFICATION", mailService.verificationContent(testUser, "tok"));
        assertThat(onlyJob().getStatus()).isEqualTo("PENDING");
        verify(javaMailSender, never()).send(any(MimeMessage.class));
    }

    @Test
    @DisplayName("Password reset email creates honest job and dispatches template")
    void testPasswordResetDispatch() {
        securityProperties.setMailMode("simulated");

        mailService.queuePasswordResetEmail(testUser, "reset-token-abc-999");

        AuthMailJob finalJob = onlyJob();
        assertThat(finalJob.getStatus()).isEqualTo("SIMULATED");
        assertThat(finalJob.getPurpose()).isEqualTo("PASSWORD_RESET");
        assertThat(finalJob.getRecipientEmail()).isEqualTo("alex@example.com");
    }

    @Test
    @DisplayName("Email templates generate valid URLs with raw tokens only in URL and clean branding")
    void testEmailTemplateContent() {
        String rawToken = "raw-test-token-777";

        var verifyContent = templateService.buildVerificationEmail("Alex", rawToken);
        assertThat(verifyContent.subject()).isEqualTo("Xác minh tài khoản English Coach");
        assertThat(verifyContent.htmlContent()).contains("https://englishcoach.io.vn/verify-email?token=" + rawToken);
        assertThat(verifyContent.htmlContent()).contains("Alex");
        assertThat(verifyContent.htmlContent()).contains("24 giờ");
        assertThat(verifyContent.textContent()).contains("https://englishcoach.io.vn/verify-email?token=" + rawToken);

        var resetContent = templateService.buildPasswordResetEmail("Alex", rawToken);
        assertThat(resetContent.subject()).isEqualTo("Đặt lại mật khẩu English Coach");
        assertThat(resetContent.htmlContent()).contains("https://englishcoach.io.vn/reset-password?token=" + rawToken);
        assertThat(resetContent.htmlContent()).contains("15 phút");
        assertThat(resetContent.textContent()).contains("https://englishcoach.io.vn/reset-password?token=" + rawToken);
    }

    @Test
    @DisplayName("A registrant's name cannot inject markup into the mail")
    void testNameEscapedInHtml() {
        var content = templateService.buildVerificationEmail("<a href=\"https://evil\">x</a>", "tok");
        assertThat(content.htmlContent()).doesNotContain("<a href=\"https://evil\">");
        assertThat(content.htmlContent()).contains("&lt;a href=&quot;https://evil&quot;&gt;");
        var notice = templateService.buildAccountExistsEmail("<b>x</b>");
        assertThat(notice.htmlContent()).doesNotContain("<b>x</b>").contains("&lt;b&gt;x&lt;/b&gt;");
    }

    @Test
    @DisplayName("Notices carry the real ways back in and no token")
    void testNoticeTemplates() {
        var exists = templateService.buildAccountExistsEmail("Alex");
        assertThat(exists.subject()).isEqualTo("Bạn đã có tài khoản English Coach");
        assertThat(exists.htmlContent()).contains("https://englishcoach.io.vn/login?mode=login", "https://englishcoach.io.vn/forgot-password");
        assertThat(exists.htmlContent()).doesNotContain("token=");
        var verified = templateService.buildAlreadyVerifiedEmail("Alex");
        assertThat(verified.subject()).isEqualTo("Email của bạn đã được xác minh");
        assertThat(verified.textContent()).contains("https://englishcoach.io.vn/login?mode=login");
    }

    @Test
    @DisplayName("Existing ACTIVE account: same response, account-exists notice prepared, no user / token created")
    void testExistingActiveAccountGetsNotice() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        testUser.setAccountStatus("ACTIVE");
        testUser.setEmailVerifiedAt(LocalDateTime.now());
        when(userRepository.findByEmailNormalized("existing@example.com")).thenReturn(Optional.of(testUser));

        RegisterRequest request = new RegisterRequest("Existing User", "existing@example.com", "SecurePass12345678");
        PreparedMail mail = registrationService.register(request, "127.0.0.1", "JUnit-Agent");

        assertThat(mail).isNotNull();
        assertThat(mail.purpose()).isEqualTo("ACCOUNT_EXISTS_NOTICE");
        assertThat(mail.content().subject()).isEqualTo("Bạn đã có tài khoản English Coach");
        verify(userRepository, never()).save(any(User.class));
        verify(actionTokenService, never()).createActionToken(any(), any(), anyLong(), any(), any(), any(), any(), anyBoolean());
        assertThat(onlyJob().getStatus()).isEqualTo("PENDING");
        verify(auditService).recordEvent(eq("REGISTRATION_SUBMITTED_EXISTING"), eq("SUCCESS"), isNull(),
                eq(testUser.getId()), isNull(), eq("127.0.0.1"), eq("JUnit-Agent"), eq("ACCOUNT_EXISTS_NOTICE"), isNull());
    }

    @Test
    @DisplayName("Existing UNVERIFIED account: a fresh verification link, earlier links kept valid")
    void testExistingPendingAccountGetsNewLink() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(userRepository.findByEmailNormalized("alex@example.com")).thenReturn(Optional.of(testUser));
        when(actionTokenService.createActionToken(any(), eq("EMAIL_VERIFICATION"), anyLong(), eq("alex@example.com"), any(), any(), anyLong(), eq(false)))
                .thenReturn("reissued-token");

        PreparedMail mail = registrationService.register(new RegisterRequest("Alex", "alex@example.com", "SecurePass12345678"), "127.0.0.1", "ua");

        assertThat(mail.purpose()).isEqualTo("EMAIL_VERIFICATION");
        assertThat(mail.content().htmlContent()).contains("verify-email?token=reissued-token");
        verify(userRepository, never()).save(any(User.class));
    }

    @Test
    @DisplayName("New user registration prepares a verification mail; delivery reports the provider's answer")
    void testNewUserRegistrationQueuesEmail() {
        smtpReady();
        doNothing().when(javaMailSender).send(any(MimeMessage.class));
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(userRepository.findByEmailNormalized("brandnew@example.com")).thenReturn(Optional.empty());
        when(passwordEncoder.encode(anyString())).thenReturn("hashed-pwd");
        when(actionTokenService.createActionToken(any(), eq("EMAIL_VERIFICATION"), anyLong(), eq("brandnew@example.com"), any(), any(), anyLong(), eq(false)))
                .thenReturn("new-user-raw-token");

        RegisterRequest request = new RegisterRequest("Brand New", "brandnew@example.com", "SecurePass12345678");
        PreparedMail mail = registrationService.register(request, "127.0.0.1", "JUnit-Agent");

        verify(userRepository).save(any(User.class));
        verify(actionTokenService).createActionToken(any(), eq("EMAIL_VERIFICATION"), eq(1440L), eq("brandnew@example.com"), isNull(), isNull(), anyLong(), eq(false));
        verify(javaMailSender, never()).send(any(MimeMessage.class));
        assertThat(registrationService.deliver(mail)).isEqualTo(DeliveryOutcome.SENT);
        assertThat(onlyJob().getStatus()).isEqualTo("SENT");
    }

    @Test
    @DisplayName("Resend verification prepares a new link for a pending user (earlier links stay valid)")
    void testResendVerificationPendingUser() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        testUser.setAccountStatus("PENDING_EMAIL");
        testUser.setEmailVerifiedAt(null);
        when(userRepository.findByEmailNormalized("alex@example.com")).thenReturn(Optional.of(testUser));
        when(actionTokenService.createActionToken(any(), eq("EMAIL_VERIFICATION"), anyLong(), eq("alex@example.com"), any(), any(), anyLong(), eq(false)))
                .thenReturn("resend-raw-token");

        Optional<PreparedMail> mail = registrationService.resendVerification(new ResendVerificationRequest("alex@example.com"), "127.0.0.1");

        assertThat(mail).isPresent();
        assertThat(mail.get().purpose()).isEqualTo("EMAIL_VERIFICATION");
        verify(actionTokenService).createActionToken(any(), eq("EMAIL_VERIFICATION"), eq(1440L), eq("alex@example.com"), isNull(), isNull(), anyLong(), eq(false));
    }

    @Test
    @DisplayName("Resend for an already-verified user prepares an 'already verified' notice, no token")
    void testResendVerificationAlreadyVerifiedUser() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        testUser.setAccountStatus("ACTIVE");
        testUser.setEmailVerifiedAt(LocalDateTime.now());
        when(userRepository.findByEmailNormalized("alex@example.com")).thenReturn(Optional.of(testUser));

        Optional<PreparedMail> mail = registrationService.resendVerification(new ResendVerificationRequest("alex@example.com"), "127.0.0.1");

        assertThat(mail).isPresent();
        assertThat(mail.get().purpose()).isEqualTo("ALREADY_VERIFIED_NOTICE");
        verify(actionTokenService, never()).createActionToken(any(), any(), anyLong(), any(), any(), any(), any(), anyBoolean());
    }

    @Test
    @DisplayName("Resend for an unknown address prepares nothing")
    void testResendUnknownAddress() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(userRepository.findByEmailNormalized("nobody@example.com")).thenReturn(Optional.empty());
        assertThat(registrationService.resendVerification(new ResendVerificationRequest("nobody@example.com"), "127.0.0.1")).isEmpty();
        assertThat(jobs).isEmpty();
    }

    @Test
    @DisplayName("Resend above the per-account limit prepares nothing (silently, same response)")
    void testResendAccountLimit() {
        when(throttleService.checkAndIncrementRateLimit(eq("RESEND_VERIFY_IP"), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(throttleService.checkAndIncrementRateLimit(eq("RESEND_VERIFY_USER"), eq("999"), eq(4), eq(30))).thenReturn(false);
        when(userRepository.findByEmailNormalized("alex@example.com")).thenReturn(Optional.of(testUser));

        assertThat(registrationService.resendVerification(new ResendVerificationRequest("alex@example.com"), "127.0.0.1")).isEmpty();
        assertThat(jobs).isEmpty();
        verify(actionTokenService, never()).createActionToken(any(), any(), anyLong(), any(), any(), any(), any(), anyBoolean());
    }

    @Test
    @DisplayName("Verifying activates the account and revokes the user's other verification links")
    void testVerifyRevokesRemaining() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(actionTokenService.findUserOfSpentToken("tok", "EMAIL_VERIFICATION")).thenReturn(Optional.empty());
        AuthActionToken token = AuthActionToken.builder().user(testUser).purpose("EMAIL_VERIFICATION").build();
        when(actionTokenService.consumeActionToken("tok", "EMAIL_VERIFICATION")).thenReturn(token);

        var outcome = registrationService.verifyEmail(new VerifyEmailRequest("tok", null), "127.0.0.1");

        assertThat(outcome).isEqualTo(RegistrationService.VerifyOutcome.VERIFIED);
        assertThat(testUser.getAccountStatus()).isEqualTo("ACTIVE");
        assertThat(testUser.getEmailVerifiedAt()).isNotNull();
        verify(actionTokenService).revokeRemaining(999L, "EMAIL_VERIFICATION");
    }

    @Test
    @DisplayName("An old link of an account verified since then answers ALREADY_VERIFIED, changes nothing")
    void testSpentLinkOfVerifiedAccount() {
        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        testUser.setAccountStatus("ACTIVE");
        testUser.setEmailVerifiedAt(LocalDateTime.now());
        when(actionTokenService.findUserOfSpentToken("old", "EMAIL_VERIFICATION")).thenReturn(Optional.of(testUser));

        var outcome = registrationService.verifyEmail(new VerifyEmailRequest("old", null), "127.0.0.1");

        assertThat(outcome).isEqualTo(RegistrationService.VerifyOutcome.ALREADY_VERIFIED);
        verify(actionTokenService, never()).consumeActionToken(any(), any());
        verify(userRepository, never()).save(any());
    }
}
