package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingSkillMasteryEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface WritingSkillMasteryRepository extends JpaRepository<WritingSkillMasteryEntity, String> {
    Optional<WritingSkillMasteryEntity> findByUserIdAndSkillCode(Long userId, String skillCode);
    List<WritingSkillMasteryEntity> findByUserIdOrderByCategoryAsc(Long userId);
}
