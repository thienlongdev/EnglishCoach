package com.englishcoach.garden.application;

import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.service.TransferCodeService;
import com.englishcoach.payment.service.VietQrService;
import org.springframework.stereotype.Component;

/**
 * Cosmetic payments through the EXISTING SePay bank-transfer integration of the Premium checkout: the same configured
 * receiving account ({@code app.payment.bank.*}), the same VietQR image service and the same transfer-code shape, so
 * SePay recognises the reference with the merchant's existing rule. Nothing here is a second merchant configuration and
 * no bank detail is written in code.
 *
 * <p>{@link #available()} requires the full production configuration — bank account AND webhook secret. The webhook
 * verifier accepts unsigned callbacks only in the {@code TEST} environment with no secret; cosmetics are never sold in
 * that state, so a forged callback can never deliver one.</p>
 */
@Component
public class SepayCosmeticGateway implements CosmeticPaymentGateway {

    private final PaymentProperties properties;
    private final TransferCodeService codes;
    private final VietQrService qr;

    public SepayCosmeticGateway(PaymentProperties properties, TransferCodeService codes, VietQrService qr) {
        this.properties = properties;
        this.codes = codes;
        this.qr = qr;
    }

    @Override
    public String provider() {
        return "SEPAY";
    }

    @Override
    public boolean available() {
        return "SEPAY".equalsIgnoreCase(properties.getProvider()) && properties.isConfiguredForProduction();
    }

    @Override
    public String createPayment(long userId, String skuCode, long amountVnd) {
        return codes.newCode();
    }

    @Override
    public Instructions instructions(String reference, long amountVnd) {
        var bank = properties.getBank();
        return new Instructions(bank.getBankCode(), bank.getAccountNumber(), bank.getAccountName(),
                qr.generateQrImageUrl(bank.getBankCode(), bank.getAccountNumber(), amountVnd, reference));
    }
}
