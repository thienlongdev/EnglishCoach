package com.englishcoach.payment.repository;

import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface PaymentTransactionRepository extends JpaRepository<PaymentTransaction, Long> {

    Optional<PaymentTransaction> findByProviderTransactionId(String providerTransactionId);

    boolean existsByProviderTransactionId(String providerTransactionId);

    List<PaymentTransaction> findByProcessingStatusOrderByReceivedAtAsc(PaymentTransactionStatus processingStatus);

    List<PaymentTransaction> findTop50ByProcessingStatusInOrderByReceivedAtAsc(List<PaymentTransactionStatus> statuses);
}
