package com.englishcoach.payment.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class SepayWebhookPayload {

    private String id;

    private String gateway;

    private String currency;

    @JsonAlias({"transaction_date", "transactionDate"})
    private String transactionDate;

    @JsonAlias({"account_number", "accountNumber"})
    private String accountNumber;

    @JsonAlias({"sub_account", "subAccount"})
    private String subAccount;

    private String code;

    private String content;

    @JsonAlias({"transfer_type", "transferType"})
    private String transferType;

    @JsonAlias({"transfer_amount", "transferAmount"})
    private Long transferAmount;

    private Long accumulative;

    @JsonAlias({"reference_code", "referenceCode"})
    private String referenceCode;

    private String description;
}
