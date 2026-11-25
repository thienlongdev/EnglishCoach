package com.englishcoach.premium.repository;

import com.englishcoach.premium.entity.PremiumSubscription;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface PremiumSubscriptionRepository extends JpaRepository<PremiumSubscription, Long> {

    @Query("SELECT s FROM PremiumSubscription s JOIN FETCH s.plan WHERE s.user.id = :userId AND s.status = 'ACTIVE' AND s.startsAt <= :now AND s.expiresAt > :now ORDER BY s.expiresAt DESC")
    List<PremiumSubscription> findActiveSubscriptions(@Param("userId") Long userId, @Param("now") Instant now);

    default Optional<PremiumSubscription> findFirstActiveSubscription(Long userId, Instant now) {
        List<PremiumSubscription> list = findActiveSubscriptions(userId, now);
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    Optional<PremiumSubscription> findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(Long userId, String status, Instant now);

    List<PremiumSubscription> findByUserIdOrderByCreatedAtDesc(Long userId);
}
