package com.englishcoach.premium.repository;

import com.englishcoach.premium.entity.PremiumPlan;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface PremiumPlanRepository extends JpaRepository<PremiumPlan, Long> {
    Optional<PremiumPlan> findByCode(String code);
    List<PremiumPlan> findByActiveTrueOrderByDisplayOrderAsc();
}
