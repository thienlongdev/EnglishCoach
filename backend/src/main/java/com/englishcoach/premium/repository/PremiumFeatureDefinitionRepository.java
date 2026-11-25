package com.englishcoach.premium.repository;

import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface PremiumFeatureDefinitionRepository extends JpaRepository<PremiumFeatureDefinition, Long> {
    Optional<PremiumFeatureDefinition> findByFeatureKey(String featureKey);
    List<PremiumFeatureDefinition> findByEnabledTrueOrderBySortOrderAsc();
}
