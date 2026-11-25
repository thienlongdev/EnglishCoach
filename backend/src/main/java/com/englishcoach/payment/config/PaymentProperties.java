package com.englishcoach.payment.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Getter
@Setter
@Configuration
@ConfigurationProperties(prefix = "app.payment")
public class PaymentProperties {

    private String provider = "SEPAY";
    private SepayConfig sepay = new SepayConfig();
    private BankConfig bank = new BankConfig();
    private String codePrefix = "EC";
    private int orderTtlMinutes = 20;

    @Getter
    @Setter
    public static class SepayConfig {
        private String env = "TEST"; // TEST or LIVE
        private String webhookSecret = "";
        /**
         * A delivery whose SIGNED timestamp is older than this is refused (security release 2026-11-16, SEC-02); 0 turns
         * the age check off. Generous on purpose: the provider retries and an operator may resend a missed delivery.
         * A delivery without a timestamp is judged by its signature alone, as before.
         */
        private int webhookMaxAgeHours = 168;
        /** A signed timestamp further than this in the future is refused (clock skew allowance). */
        private int webhookFutureSkewMinutes = 15;
    }

    @Getter
    @Setter
    public static class BankConfig {
        private String bankCode = "";
        private String accountNumber = "";
        private String accountName = "";
    }

    public boolean isConfiguredForProduction() {
        return sepay.getWebhookSecret() != null && !sepay.getWebhookSecret().isBlank()
                && bank.getBankCode() != null && !bank.getBankCode().isBlank()
                && bank.getAccountNumber() != null && !bank.getAccountNumber().isBlank()
                && bank.getAccountName() != null && !bank.getAccountName().isBlank();
    }
}
