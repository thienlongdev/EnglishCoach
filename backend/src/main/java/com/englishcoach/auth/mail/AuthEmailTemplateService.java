package com.englishcoach.auth.mail;

import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

@Service
@RequiredArgsConstructor
public class AuthEmailTemplateService {

    private final AuthSecurityProperties securityProperties;

    public record EmailContent(String subject, String htmlContent, String textContent) {}

    public EmailContent buildVerificationEmail(String recipientName, String rawToken) {
        String baseUrl = cleanBaseUrl(securityProperties.getBaseUrl());
        String encodedToken = URLEncoder.encode(rawToken, StandardCharsets.UTF_8);
        String actionUrl = baseUrl + "/verify-email?token=" + encodedToken;

        String displayName = (recipientName != null && !recipientName.isBlank()) ? recipientName.trim() : "bạn";
        String subject = "Xác minh tài khoản English Coach";

        String htmlContent = """
            <!DOCTYPE html>
            <html lang="vi">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Xác minh tài khoản English Coach</title>
              <style>
                body { margin: 0; padding: 0; background-color: #0b132b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
                .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
                .card { background-color: #ffffff; border-radius: 16px; padding: 40px 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
                .brand { display: flex; align-items: center; justify-content: center; margin-bottom: 24px; }
                .brand-title { font-size: 22px; font-weight: 800; color: #1e293b; margin: 0; letter-spacing: -0.5px; }
                .badge { display: inline-block; background-color: #e0f2fe; color: #0284c7; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 16px; }
                h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; }
                p { font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
                .btn-container { text-align: center; margin: 32px 0; }
                .btn { display: inline-block; background: linear-gradient(135deg, #4f46e5 0%%, #06b6d4 100%%); color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 12px; box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35); }
                .link-fallback { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-top: 24px; word-break: break-all; font-family: monospace; font-size: 13px; color: #334155; }
                .footer { text-align: center; margin-top: 32px; font-size: 12px; line-height: 1.5; color: #94a3b8; }
                .warning { font-size: 13px; color: #64748b; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="card">
                  <div class="brand" style="text-align: center;">
                    <span class="brand-title">🐋 English Coach</span>
                  </div>
                  <div style="text-align: center;">
                    <span class="badge">Xác minh tài khoản</span>
                  </div>
                  <h1>Chào mừng %s đến với English Coach!</h1>
                  <p>Cảm ơn bạn đã đăng ký tài khoản. Để bắt đầu hành trình luyện tiếng Anh và nhận phản hồi từ AI Coach Echo, vui lòng xác minh địa chỉ email của bạn bằng nút bên dưới:</p>
                  
                  <div class="btn-container">
                    <a href="%s" class="btn" target="_blank">Xác minh tài khoản ngay</a>
                  </div>
                  
                  <p style="font-size: 13px; color: #64748b;">Liên kết xác thực có hiệu lực trong vòng <strong>24 giờ</strong>.</p>
                  
                  <p style="font-size: 13px; margin-bottom: 6px;">Nếu nút trên không hoạt động, bạn có thể sao chép và dán liên kết sau vào trình duyệt:</p>
                  <div class="link-fallback">%s</div>
                  
                  <div class="warning">
                    <strong>Lưu ý bảo mật:</strong> Nếu bạn không tạo tài khoản tại English Coach, vui lòng bỏ qua email này. Không ai có thể truy cập tài khoản khi chưa xác minh.
                  </div>
                </div>
                <div class="footer">
                  © 2026 English Coach. Nền tảng luyện nói & phản xạ tiếng Anh toàn diện.<br>
                  Email tự động từ hệ thống, vui lòng không phản hồi trực tiếp thư này.
                </div>
              </div>
            </body>
            </html>
            """.formatted(escape(displayName), actionUrl, actionUrl);

        String textContent = """
            Chào mừng %s đến với English Coach!
            
            Cảm ơn bạn đã đăng ký tài khoản tại English Coach.
            Vui lòng mở liên kết sau để xác minh địa chỉ email của bạn (hiệu lực trong 24 giờ):
            %s
            
            Nếu bạn không đăng ký tài khoản này, vui lòng bỏ qua email.
            
            --
            English Coach - Nền tảng luyện nói & phản xạ tiếng Anh
            """.formatted(displayName, actionUrl);

        return new EmailContent(subject, htmlContent, textContent);
    }

    public EmailContent buildPasswordResetEmail(String recipientName, String rawToken) {
        String baseUrl = cleanBaseUrl(securityProperties.getBaseUrl());
        String encodedToken = URLEncoder.encode(rawToken, StandardCharsets.UTF_8);
        String actionUrl = baseUrl + "/reset-password?token=" + encodedToken;

        String displayName = (recipientName != null && !recipientName.isBlank()) ? recipientName.trim() : "bạn";
        String subject = "Đặt lại mật khẩu English Coach";

        String htmlContent = """
            <!DOCTYPE html>
            <html lang="vi">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Đặt lại mật khẩu English Coach</title>
              <style>
                body { margin: 0; padding: 0; background-color: #0b132b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
                .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
                .card { background-color: #ffffff; border-radius: 16px; padding: 40px 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
                .brand { display: flex; align-items: center; justify-content: center; margin-bottom: 24px; }
                .brand-title { font-size: 22px; font-weight: 800; color: #1e293b; margin: 0; letter-spacing: -0.5px; }
                .badge { display: inline-block; background-color: #fef3c7; color: #b45309; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 16px; }
                h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; }
                p { font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
                .btn-container { text-align: center; margin: 32px 0; }
                .btn { display: inline-block; background: linear-gradient(135deg, #4f46e5 0%%, #e11d48 100%%); color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 32px; border-radius: 12px; box-shadow: 0 4px 14px rgba(225, 29, 72, 0.3); }
                .link-fallback { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-top: 24px; word-break: break-all; font-family: monospace; font-size: 13px; color: #334155; }
                .footer { text-align: center; margin-top: 32px; font-size: 12px; line-height: 1.5; color: #94a3b8; }
                .warning { font-size: 13px; color: #b91c1c; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px 16px; margin-top: 24px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="card">
                  <div class="brand" style="text-align: center;">
                    <span class="brand-title">🐋 English Coach</span>
                  </div>
                  <div style="text-align: center;">
                    <span class="badge">Bảo mật tài khoản</span>
                  </div>
                  <h1>Yêu cầu đặt lại mật khẩu</h1>
                  <p>Xin chào %s,</p>
                  <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản English Coach của bạn. Vui lòng bấm vào nút bên dưới để tiến hành thiết lập mật khẩu mới:</p>
                  
                  <div class="btn-container">
                    <a href="%s" class="btn" target="_blank">Đặt lại mật khẩu</a>
                  </div>
                  
                  <p style="font-size: 13px; color: #64748b;">Vì lý do an toàn, liên kết này sẽ hết hạn sau <strong>15 phút</strong>.</p>
                  
                  <p style="font-size: 13px; margin-bottom: 6px;">Nếu nút trên không hoạt động, bạn có thể sao chép liên kết sau:</p>
                  <div class="link-fallback">%s</div>
                  
                  <div class="warning">
                    <strong>Cảnh báo bảo mật:</strong> Nếu bạn KHÔNG thực hiện yêu cầu này, bạn có thể yên tâm bỏ qua email này. Mật khẩu hiện tại của bạn vẫn được giữ an toàn và không thay đổi.
                  </div>
                </div>
                <div class="footer">
                  © 2026 English Coach. Nền tảng luyện nói & phản xạ tiếng Anh toàn diện.<br>
                  Email tự động từ hệ thống, vui lòng không phản hồi trực tiếp thư này.
                </div>
              </div>
            </body>
            </html>
            """.formatted(escape(displayName), actionUrl, actionUrl);

        String textContent = """
            Xin chào %s,
            
            Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản English Coach của bạn.
            Vui lòng mở liên kết sau để thiết lập mật khẩu mới (liên kết có hiệu lực trong 15 phút):
            %s
            
            Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua thư này. Mật khẩu của bạn vẫn an toàn.
            
            --
            English Coach - Nền tảng luyện nói & phản xạ tiếng Anh
            """.formatted(displayName, actionUrl);

        return new EmailContent(subject, htmlContent, textContent);
    }

    /**
     * Sent when someone registers with an address that already has an ACTIVE account: the owner of the inbox learns
     * that the account exists (the web page never says so) and gets the two real ways back in. No token, no link that
     * changes anything.
     */
    public EmailContent buildAccountExistsEmail(String recipientName) {
        String baseUrl = cleanBaseUrl(securityProperties.getBaseUrl());
        return buildNotice(
                "Bạn đã có tài khoản English Coach",
                "Tài khoản đã tồn tại",
                recipientName,
                "Chúng tôi vừa nhận được yêu cầu tạo tài khoản mới bằng địa chỉ email này, nhưng địa chỉ này đã có tài khoản English Coach. Không có tài khoản mới nào được tạo.",
                "Bạn có thể đăng nhập bằng mật khẩu hiện tại hoặc bằng Google. Nếu không nhớ mật khẩu, hãy đặt lại mật khẩu.",
                "Đăng nhập", baseUrl + "/login?mode=login",
                "Quên mật khẩu?", baseUrl + "/forgot-password",
                "Nếu không phải bạn gửi yêu cầu này, bạn có thể bỏ qua email. Tài khoản của bạn không thay đổi.");
    }

    /** Sent when a verification email is requested for an address whose account is already verified. */
    public EmailContent buildAlreadyVerifiedEmail(String recipientName) {
        String baseUrl = cleanBaseUrl(securityProperties.getBaseUrl());
        return buildNotice(
                "Email của bạn đã được xác minh",
                "Đã xác minh",
                recipientName,
                "Chúng tôi vừa nhận được yêu cầu gửi lại email xác minh cho địa chỉ này. Tài khoản English Coach của bạn đã được xác minh trước đó, nên không cần xác minh thêm.",
                "Bạn có thể đăng nhập ngay bằng mật khẩu hoặc bằng Google.",
                "Đăng nhập", baseUrl + "/login?mode=login",
                "Quên mật khẩu?", baseUrl + "/forgot-password",
                "Nếu không phải bạn gửi yêu cầu này, bạn có thể bỏ qua email. Tài khoản của bạn không thay đổi.");
    }

    private EmailContent buildNotice(String subject, String badge, String recipientName, String lead, String body,
                                     String primaryLabel, String primaryUrl, String secondaryLabel, String secondaryUrl,
                                     String footnote) {
        String displayName = (recipientName != null && !recipientName.isBlank()) ? escape(recipientName.trim()) : "bạn";
        String htmlContent = """
            <!DOCTYPE html>
            <html lang="vi">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>%s</title>
            </head>
            <body style="margin:0;padding:0;background-color:#0b132b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
                <div style="background-color:#ffffff;border-radius:16px;padding:40px 32px;">
                  <div style="text-align:center;margin-bottom:24px;"><span style="font-size:22px;font-weight:800;color:#1e293b;">🐋 English Coach</span></div>
                  <div style="text-align:center;"><span style="display:inline-block;background-color:#e0f2fe;color:#0284c7;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:700;text-transform:uppercase;margin-bottom:16px;">%s</span></div>
                  <h1 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 12px 0;">Xin chào %s,</h1>
                  <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px 0;">%s</p>
                  <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px 0;">%s</p>
                  <div style="text-align:center;margin:32px 0 16px 0;">
                    <a href="%s" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#4f46e5 0%%,#06b6d4 100%%);color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:12px;">%s</a>
                  </div>
                  <div style="text-align:center;margin-bottom:8px;"><a href="%s" target="_blank" style="color:#4f46e5;font-size:14px;font-weight:600;">%s</a></div>
                  <p style="font-size:13px;color:#64748b;margin:24px 0 0 0;border-top:1px solid #f1f5f9;padding-top:16px;">%s</p>
                </div>
                <div style="text-align:center;margin-top:32px;font-size:12px;line-height:1.5;color:#94a3b8;">
                  © 2026 English Coach. Nền tảng luyện nói &amp; phản xạ tiếng Anh toàn diện.<br>
                  Email tự động từ hệ thống, vui lòng không phản hồi trực tiếp thư này.
                </div>
              </div>
            </body>
            </html>
            """.formatted(subject, badge, displayName, lead, body, primaryUrl, primaryLabel, secondaryUrl, secondaryLabel, footnote);

        String textContent = """
            Xin chào %s,

            %s

            %s

            %s: %s
            %s: %s

            %s

            --
            English Coach - Nền tảng luyện nói & phản xạ tiếng Anh
            """.formatted(recipientName != null && !recipientName.isBlank() ? recipientName.trim() : "bạn",
                lead, body, primaryLabel, primaryUrl, secondaryLabel, secondaryUrl, footnote);

        return new EmailContent(subject, htmlContent, textContent);
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private String cleanBaseUrl(String rawBaseUrl) {
        if (rawBaseUrl == null || rawBaseUrl.isBlank()) {
            return "http://localhost:3000";
        }
        return rawBaseUrl.trim().replaceAll("/+$", "");
    }
}
