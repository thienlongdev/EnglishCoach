package com.englishcoach.auth.mail;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Component
@Slf4j
public class SimulatedMailDeliveryAdapter implements MailDeliveryAdapter {

    @Override
    public MailDeliveryResult sendEmail(String to, String subject, String htmlContent, String textContent) {
        log.info("[Mail:Simulated] Simulated mail delivery to recipient: {} (Subject: '{}')", com.englishcoach.common.security.LogMask.email(to), subject);
        return MailDeliveryResult.asSimulated();
    }

    @Override
    public boolean isLiveDelivery() {
        return false;
    }

    @Override
    public String getAdapterName() {
        return "SIMULATED";
    }
}
