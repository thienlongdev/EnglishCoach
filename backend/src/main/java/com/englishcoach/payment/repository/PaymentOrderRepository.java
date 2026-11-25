package com.englishcoach.payment.repository;

import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface PaymentOrderRepository extends JpaRepository<PaymentOrder, Long> {

    Optional<PaymentOrder> findByTransferCode(String transferCode);

    Optional<PaymentOrder> findByIdAndUserId(Long id, Long userId);

    List<PaymentOrder> findByUserIdOrderByCreatedAtDesc(Long userId);

    boolean existsByTransferCode(String transferCode);

    @org.springframework.data.jpa.repository.Modifying
    @Query("UPDATE PaymentOrder o SET o.status = 'EXPIRED', o.updatedAt = :now WHERE o.status = 'PENDING' AND o.expiresAt <= :now")
    int expirePending(@Param("now") Instant now);

    @Query("SELECT po FROM PaymentOrder po WHERE po.user.id = :userId AND po.planCodeSnapshot = :planCode AND po.status = :status AND po.expiresAt > :now ORDER BY po.createdAt DESC")
    List<PaymentOrder> findActivePendingOrders(
            @Param("userId") Long userId,
            @Param("planCode") String planCode,
            @Param("status") PaymentOrderStatus status,
            @Param("now") Instant now
    );
}
