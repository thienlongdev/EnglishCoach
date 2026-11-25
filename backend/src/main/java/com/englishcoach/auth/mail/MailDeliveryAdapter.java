package com.englishcoach.auth.mail;

public interface MailDeliveryAdapter {

    MailDeliveryResult sendEmail(String to, String subject, String htmlContent, String textContent);

    boolean isLiveDelivery();

    String getAdapterName();
}
