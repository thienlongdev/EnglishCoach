package com.englishcoach.payment.service;

import com.englishcoach.payment.config.PaymentProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

@Slf4j
@Service
@RequiredArgsConstructor
public class VietQrService {

    private final PaymentProperties paymentProperties;

    /**
     * Builds dynamic VietQR image URL with exact amount, bank code, receiving account, and transfer code.
     * All values are strictly backend-authoritative.
     */
    public String generateQrImageUrl(String bankCode, String accountNumber, Long amountVnd, String transferCode) {
        String resolvedBank = (bankCode != null && !bankCode.isBlank()) 
                ? bankCode 
                : paymentProperties.getBank().getBankCode();
        String resolvedAccount = (accountNumber != null && !accountNumber.isBlank()) 
                ? accountNumber 
                : paymentProperties.getBank().getAccountNumber();

        if (resolvedBank == null || resolvedBank.isBlank() || resolvedAccount == null || resolvedAccount.isBlank()) {
            log.warn("Cannot construct live VietQR image URL: receiving bank details unconfigured");
            return "";
        }

        try {
            String encodedBank = URLEncoder.encode(resolvedBank.trim(), StandardCharsets.UTF_8);
            String encodedAcc = URLEncoder.encode(resolvedAccount.trim(), StandardCharsets.UTF_8);
            String encodedMemo = URLEncoder.encode(transferCode.trim(), StandardCharsets.UTF_8);

            // Official SePay dynamic VietQR image service
            return String.format("https://qr.sepay.vn/img?bank=%s&acc=%s&template=compact&amount=%d&des=%s",
                    encodedBank, encodedAcc, amountVnd, encodedMemo);
        } catch (Exception e) {
            log.error("Failed to encode VietQR URL: {}", e.getMessage());
            return "";
        }
    }
}
